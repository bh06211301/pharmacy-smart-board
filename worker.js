// ============================================================
// 藥局業務智能 Worker v3
// 新增：POST/GET /customer-status — 客戶狀態管理（死客戶標記）
// 2026-10-24：死客戶／負責人(我/老爸) 改讀寫 新客戶資料表_AppSheet 的 停用(Z)/負責人(AA) 欄，
//            取代原本的「客戶狀態」分頁代理與 dad:pharmacies KV（見下方【/customer-status】【/dad-pharmacies】）
// ============================================================
// 環境變數：
//   GEMINI_API_KEY
//   SHEET_PHARMACY  = 1qJ62K5Hd2bKP9DdQTjwJOOy0njNICMSPiayW7YJZdNM
//   SHEET_VISIT     = 10rofUuKtji4tKGyUv6cvbsiTEq1ynRP0zJxohc3l68U
//   SHEET_PRODUCT   = 1tyJYRWVPl7F5kprBylR_WbbIVayIWQEUxdQ-2sCL-cM
//   SHEET_ORDER     = 13HB7e9mzL0H6Nhfyl-AKhjO8M_GElnqPldTk-u-0ni8
// ============================================================

import { PLANNER_CONFIG } from './planner-config.js';

const GEMINI_MODEL = 'gemini-3.5-flash-lite';
const GEMINI_MODEL_PRO = 'gemini-3.5-flash-lite';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const GEMINI_URL_PRO = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL_PRO}:generateContent`;

const GAS_URL = 'https://script.google.com/macros/s/AKfycbxdCQvTWLTLtTLrpL5gpZZrvsEAujA0xnQ9gOiX0o23mR2y6ZTJHtSDqEmt_LmqZBFA/exec';
const GAS_VISIT_URL = 'https://script.google.com/macros/s/AKfycbxBDS60OKaAhxeS53qrN7O1TbbN_wHSaJgwKJeFVjgr8ZuxpS-RV6aRu-uEwTJwKvzN9g/exec';
// 新開藥局篩選（new-pharmacy-screening）的 Web App，讀「藥局每日異動追蹤」篩選分頁。
// 這份試算表沒有開「知道連結的人可檢視」（跟其他 SHEET_* 不同），gviz 直接讀會是登入頁，
// 改用它自己的 doGet API（已經是 FIELD 對應好的 JSON，含 stage/stageDate），密碼走 wrangler secret：SCREENING_API_TOKEN
const SCREENING_API_URL = 'https://script.google.com/macros/s/AKfycbyUJrKP1PsAOsQx8sVnJE5dwMhsn7LdEdZctsP_Y_T8em7AM5BtubDDpR1eL-1ZLxUNuQ/exec';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

// ============================================================
// ★ 資料合約（前後端共同依賴，修改前必讀）
// ============================================================
//
// 【待辦事項欄位 — todos-v2 KV 儲存格式】
//   id, task, quadrant, pharmacyId, pharmacyName,
//   scheduledDate, done, doneAt,
//   resolution,          ← 解決方案（前端 saveResolution 寫入此欄位）
//   aiSuggestions,       ← AI 建議準備事項陣列
//   relatedTodoIds,      ← 關聯待辦 id 陣列
//   sourceVisitId, sourceVisitDate,
//   type,                ← return_receipt | get_receipt | revisit | prepare | follow_up | other
//   source,
//   createdAt
//
// 【有效象限值】前端 QMETA 與此處 AI prompt 必須一致
//   ui | ii | iii | iv | pool | dad | invoice
//   AI 只建議前五種（dad / invoice 由系統自動設定）
//   2026-10-23 拿掉 pending_newph／newph：從沒接過真的資料來源的空殼篩選機制，
//   新開藥局篩選改用 new-pharmacy-screening（screening.html）那一套
//
// 【/today-orders — 今日出貨清單（訂單主檔）】
//   GET  → { ok, date, orders: [{orderNo,storeCode,storeName,totalAmount,status}] }
//   SHEET_ORDER_MASTER = 1qa5aqeAPZlo8hyNMA6xD4VCk334B3pnhKyLSkBbhcmo
//
// 【/invoice-tasks — 帳務清單（寄單/請款）】
//   GET  → { ok, invoicing:[...], collection:[...] }
//   invoicing : 紅單實體狀態=寄賣中(資料夾) AND 今月 >= 訂單月+7
//   collection: 紅單實體狀態=待請款(已寄單)
//
// 【POST /add-visit 期望欄位】
//   action, visitId, pharmacyName, date, purpose, content
//   ↑ index.html 的 submitNewVisit 與 field.html 的打卡送出都必須傳這些欄位
//   注意：pharmacyId 前端有傳但 handleAddVisit 不轉送（GAS 拜訪紀錄表無此欄）
//
// 【/calendar-plan — 月曆計畫 KV 持久化】
//   GET  → { ok, plan: { "2026-07-07": { pharmacies:[{id,name,address}], route:{...} } } }
//   PUT  → body: { plan: {...} }，回傳 { ok }
//   KV key: calendar:plan
//
// 【/customer-status — 死客戶標記，2026-10-24 改為讀寫主表「停用」欄】
//   GET  → { ok, statuses: { [Customer_ID]: {status:'dead', note} } }（讀 /pharmacies 的 deadReason，非空才列入）
//   POST → body: { id, status:'dead'|'active', note }，寫入 GAS_VISIT_URL action:'updatePharmacyFlag' field:'dead'
//          status='dead' 且 note 空白時預設寫入「死客戶」（欄位只要非空值就算死客戶，不能寫空字串）
//
// 【/dad-pharmacies — 爸爸客戶清單，2026-10-24 改為讀寫主表「負責人」欄】
//   GET  → { ok, ids: ['C116',...] }（讀 /pharmacies 裡 owner === '老爸' 的 id）
//   POST → body: { id, action: 'add'|'remove' }，回傳 { ok, ids }
//          寫入 GAS_VISIT_URL action:'updatePharmacyFlag' field:'dad'，value 為 '老爸'（add）或 ''（remove，預設即我）
//
// ============================================================

// ============================================================
// 路由
// ============================================================
export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === '/health') {
        return json({ ok: true, model: GEMINI_MODEL, time: new Date().toISOString() });
      }

      if (path === '/generate-script' && request.method === 'POST') {
        return await handleGenerateScript(request, env);
      }

      if (path === '/optimize-route' && request.method === 'POST') {
        return await handleOptimizeRoute(request, env);
      }

      if (path === '/pharmacies' && request.method === 'GET') {
        return await handleGetPharmacies(request, env);
      }

      if (path.startsWith('/visits/') && request.method === 'GET') {
        const pharmacyId = decodeURIComponent(path.replace('/visits/', ''));
        return await handleGetVisits(pharmacyId, env);
      }

      if (path === '/visits-summary' && request.method === 'GET') {
        return await handleVisitsSummary(env);
      }

      if (path === '/orders-summary' && request.method === 'GET') {
        return await handleOrdersSummary(env);
      }

      if (path === '/recommend-today' && request.method === 'GET') {
        return await handleRecommendToday(env);
      }

      // ★ 新增：客戶狀態管理
      if (path === '/customer-status') {
        return await handleCustomerStatus(request, env);
      }

      // ★ 新增：業務待辦清單（舊版，保留相容）
      if (path === '/todos') {
        return await handleTodos(request);
      }

      // ★ 新版待辦清單（KV 持久化）
      if (path === '/todos-v2') {
        return await handleTodosV2(request, env);
      }

      // ★ AI 待辦建議
      if (path === '/ai-todo-suggest' && request.method === 'POST') {
        return await handleAiTodoSuggest(request, env);
      }

      // ★ 藥局名稱偵測（字串比對）
      if (path === '/ai-pharmacy-detect' && request.method === 'POST') {
        return await handlePharmacyDetect(request);
      }

      // ★ 產品清單
      if (path === '/products' && request.method === 'GET') {
        return await handleGetProducts(env);
      }

      // ★ 依產品查詢進貨藥局
      if (path === '/product-orders' && request.method === 'GET') {
        return await handleProductOrders(request, env);
      }


      if (path === '/all-visits' && request.method === 'GET') {
        return await handleAllVisits(env);
      }

      if (path === '/analyze-tasks' && request.method === 'POST') {
        return await handleAnalyzeTasks(request, env);
      }

      if (path === '/add-visit' && request.method === 'POST') {
        return await handleAddVisit(request);
      }

      // ★ 月曆計畫（KV 持久化）
      if (path === '/calendar-plan') {
        return await handleCalendarPlan(request, env);
      }

      // ★ 爸爸客戶清單（KV 持久化）
      if (path === '/dad-pharmacies') {
        return await handleDadPharmacies(request, env);
      }

      // ★ 今日出貨清單（訂單主檔）
      if (path === '/today-orders' && request.method === 'GET') {
        return await handleTodayOrders(env);
      }

      // ★ 帳務清單（寄單 + 請款）
      if (path === '/invoice-tasks' && request.method === 'GET') {
        return await handleInvoiceTasks(env);
      }

      // ★ 盤點候選產品清單
      if (path === '/inventory-candidates' && request.method === 'GET') {
        return await handleInventoryCandidates(request, env);
      }

      // ★ 盤點批次寫入
      if (path === '/inventory-submit' && request.method === 'POST') {
        return await handleInventorySubmit(request, env);
      }

      // ★ LINE 速記解析 → 結構化訂單草稿（只回傳，不寫入任何資料表）
      if (path === '/parse-line-notes' && request.method === 'POST') {
        return await handleParseLineNotes(request, env);
      }

      // ★ 產品照片（R2）
      if (path.startsWith('/product-photo/') && request.method === 'GET') {
        const key = decodeURIComponent(path.replace('/product-photo/', ''));
        return await handleProductPhoto(key, env);
      }

      // ★ 藥局資訊總覽（出貨明細 + 退貨紀錄 + 盤點歷史）
      if (path === '/pharmacy-profile' && request.method === 'GET') {
        return await handlePharmacyProfile(request, env);
      }

      // ★ SmartRoute 規劃流程 v2 第 1 階段：推薦清單（倍數＋待追蹤分）
      if (path === '/api/plan' && request.method === 'GET') {
        return await handlePlannerPlan(request, env);
      }

      // ★ Phase 2：儲存當天的錨點清單＋確定路線（A1 第①③欄用，KV 持久化）
      if (path === '/api/plan' && request.method === 'POST') {
        return await handleSavePlan(request, env);
      }

      // ★ 2026-10-27 新增：客戶叫貨健康度分級（只讀分析，跟 /api/plan 完全獨立、不影響 SmartRoute 評分）
      // 只在 wrangler dev 本機測，還沒決定要不要留、要不要 commit
      if (path === '/api/customer-tiers' && request.method === 'GET') {
        return await handleCustomerTiers(env);
      }

      // ★ 店家規則（代理到 GAS 的 addRule/updateRule）
      if (path === '/api/rules' && request.method === 'POST') {
        return await handlePlannerRules(request, env);
      }

      // ★ 待追蹤（代理到 GAS 的 addFollowup/resolveFollowup）
      if (path === '/api/followups' && request.method === 'POST') {
        return await handlePlannerFollowups(request, env);
      }

      // ★ Phase 2：A8 藥局檔案抽屜要的單店全部資料（分級、規則、待追蹤）
      if (path === '/api/store' && request.method === 'GET') {
        return await handleStoreDetail(request, env);
      }

      return json({ error: '找不到這個 endpoint' }, 404);

    } catch (err) {
      console.error('Worker error:', err);
      return json({ error: err.message }, 500);
    }
  }
};

// ============================================================
// 1. AI 話術生成
// ============================================================
async function handleGenerateScript(request, env) {
  const body = await request.json();
  const {
    pharmacyId, pharmacyName, pharmacist,
    lastVisitDays, lastVisitNote, recentOrders, visitPurpose,
    recentVisits, chatTopics, background, profileNote
  } = body;

  if (!pharmacyName) return json({ error: '缺少 pharmacyName' }, 400);

  const dayText = lastVisitDays ? `距上次拜訪 ${lastVisitDays} 天` : '首次拜訪';
  const urgency = lastVisitDays > 21
    ? '⚠️ 逾期未訪，需特別用心'
    : lastVisitDays > 14 ? '稍久未訪' : '近期有拜訪';

  const orderText = recentOrders && recentOrders.length > 0
    ? recentOrders.map(o => `${o.name}（${o.qty}件，$${o.price}）`).join('、')
    : '尚無出貨紀錄';

  const visitsHistory = recentVisits && recentVisits.length > 0
    ? recentVisits.slice(0, 5).map(v =>
        `• ${v.date}【${v.purpose || '拜訪'}】${v.summary || v.content || ''}${v.actionItems ? '　待辦：' + v.actionItems : ''}`
      ).join('\n')
    : lastVisitNote ? `• 最近紀錄：${lastVisitNote}` : '（無紀錄）';

  const profileSection = (chatTopics || background || profileNote)
    ? `\n【藥師個人資料】\n${chatTopics ? `聊天話題：${chatTopics}\n` : ''}${background ? `家庭背景：${background}\n` : ''}${profileNote ? `備註：${profileNote}\n` : ''}`
    : '';

  const prompt = `你是資深藥局業務顧問，根據過去的拜訪紀錄，幫業務員規劃這次拜訪的「聊天方向」。請直接輸出以下三段內容，不要任何前言或開場白。

【藥局資訊】
藥局：${pharmacyName}　藥師：${pharmacist || '不詳'}
距上次拜訪：${dayText}（${urgency}）
近期進貨：${orderText}
本次目的：${visitPurpose || '例行拜訪'}${profileSection}
【最近拜訪紀錄（從新到舊）】
${visitsHistory}

【請輸出以下三段，繁體中文，每段簡短有重點】

**本次建議聊的方向**
根據以上紀錄，列 2-3 個這次去值得聊的具體話題，每項一行加 emoji，說明為什麼要聊、預期效果

**開場切入點**
一句自然的開場白，帶入上次具體發生的事（例：上次承諾的事、上次留下的問題），像真人說話，不要模板化

**這次要注意**
1-2 件特別要追蹤或注意的事，尤其是上次的待辦有沒有落實`;

  const payload = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { maxOutputTokens: 1200, temperature: 0.75 }
  };

  let geminiRes = await fetch(`${GEMINI_URL}?key=${env.GEMINI_API_KEY}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  let geminiData = await geminiRes.json();

  if (!geminiRes.ok && geminiData?.error?.message?.includes('quota')) {
    geminiRes = await fetch(`${GEMINI_URL_PRO}?key=${env.GEMINI_API_KEY}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    geminiData = await geminiRes.json();
  }

  if (!geminiRes.ok) {
    return json({ error: `Gemini 錯誤：${geminiData?.error?.message}` }, 500);
  }

  const script = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || '';

  return json({
    ok: true, pharmacyId, pharmacyName,
    script: script.trim(), model: GEMINI_MODEL,
    context: { dayText, urgency, orderText }
  });
}

// ============================================================
// 2. 路線排序
// ============================================================
async function handleOptimizeRoute(request, env) {
  const body = await request.json();
  const { pharmacies, origin } = body;

  if (!pharmacies || pharmacies.length === 0) {
    return json({ error: '缺少藥局清單' }, 400);
  }

  const scored = pharmacies.map(p => {
    let score = 0;
    if (p.lastVisitDays > 21) score += 50;
    else if (p.lastVisitDays > 14) score += 30;
    else if (p.lastVisitDays > 7)  score += 10;
    if (p.isNew)       score += 40;
    if (p.isDad)       score += 35;
    if (p.hasDelivery) score += 25;
    if (p.pendingOrder) score += 20;
    return { ...p, priorityScore: score };
  });

  scored.sort((a, b) => b.priorityScore - a.priorityScore);

  const topList = scored.slice(0, 6).map((p, i) =>
    `${i+1}. ${p.name}（優先分${p.priorityScore}，距上次拜訪${p.lastVisitDays || '?'}天${p.isNew?' [新藥局]':''}${p.isDad?' [爸爸老客戶]':''}${p.hasDelivery?' [需自送]':''}）`
  ).join('\n');

  const prompt = `以下是今日建議拜訪的藥局排序（已依優先級排好），請用一句話說明每家的拜訪重點，繁體中文，簡短：\n${topList}`;

  const geminiRes = await fetch(`${GEMINI_URL}?key=${env.GEMINI_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: 300 }
    })
  });

  const geminiData = await geminiRes.json();
  const summary = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || '';

  return json({ ok: true, route: scored, summary: summary.trim(), totalStops: scored.length });
}

// ============================================================
// 3. 藥局清單
// ============================================================
async function handleGetPharmacies(request, env) {
  const sheetId = env.SHEET_PHARMACY;
  const sheetName = '新客戶資料表_AppSheet';
  const url = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:json&sheet=${encodeURIComponent(sheetName)}`;

  const res = await fetch(url);
  const text = await res.text();
  const jsonStr = text.replace(/^.*?({.*}).*$/s, '$1');
  const data = JSON.parse(jsonStr);

  const rows = data?.table?.rows || [];
  const cols = data?.table?.cols || [];
  const colMap = {};
  cols.forEach((c, i) => { colMap[c.label] = i; });

  const pharmacies = rows.map(row => {
    const get = (label) => row.c[colMap[label]]?.v ?? '';
    return {
      id:          get('Customer_ID'),
      name:        get('店名'),
      address:     get('地址'),
      lat:         parseFloat(get('緯度'))  || null,
      lng:         parseFloat(get('經度'))  || null,
      pharmacist:  get('Key Man'),
      greeting:    get('稱呼'), // L欄「稱呼」才是真人姓名；K欄「Key Man」實際存的是職稱(例如「藥師」)，兩者意思相反，CLAUDE.md已記錄過這個坑
      phone:       get('電話'),
      area:        get('實體資料夾'),
      city:        get('縣市'),
      district:    get('行政區'),
      chatTopics:  get('聊天話題'),
      background:  get('家庭背景'),
      profileNote: get('藥師備註'),
      deadReason:  get('停用') || '',   // 非空字串＝死客戶，空字串＝正常客戶
      owner:       get('負責人') || '', // '老爸' 或 '我'（含空白，視為我）
      status:      get('狀態') || '',   // C 欄，2026-10-27 補：'其他通路' 用來排除叫貨統計抓不到的客戶（見 SPEC 4.5）
    };
  }).filter(p => p.id && p.name);

  return json({ ok: true, count: pharmacies.length, pharmacies });
}

// ============================================================
// 4. 單一藥局拜訪紀錄
// ============================================================
async function handleGetVisits(pharmacyId, env) {
  const sheetId = env.SHEET_VISIT;
  const sheetName = '拜訪紀錄表';
  const url = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:json&sheet=${encodeURIComponent(sheetName)}`;

  const res = await fetch(url);
  const text = await res.text();
  const jsonStr = text.replace(/^.*?({.*}).*$/s, '$1');
  const data = JSON.parse(jsonStr);

  const rows = data?.table?.rows || [];
  const cols = data?.table?.cols || [];
  const colMap = {};
  cols.forEach((c, i) => { colMap[c.label] = i; });

  function parseGvizDate(val) {
    if (!val) return '';
    const m = String(val).match(/Date\((\d+),(\d+),(\d+)\)/);
    if (m) return `${m[1]}/${parseInt(m[2])+1}/${m[3]}`;
    return String(val);
  }

  function cleanField(val) {
    const s = String(val || '');
    if (s.match(/^\[L.*@[0-9a-f]+$/)) return '';
    return s;
  }

  const visits = rows
    .filter(row => (row.c[colMap['店名']]?.v || '') === pharmacyId)
    .map(row => {
      const get = (label) => row.c[colMap[label]]?.v ?? '';
      return {
        visitId:     cleanField(get('Visit ID')),
        date:        parseGvizDate(row.c[colMap['拜訪日期']]?.v || ''),
        purpose:     cleanField(get('拜訪目的')),
        content:     cleanField(get('拜訪內容')),
        summary:     cleanField(get('Summary')),
        painPoints:  cleanField(get('Pain Points')),
        actionItems: cleanField(get('Action Items')),
        tags:        cleanField(get('Tags')),
        nextFollow:  parseGvizDate(get('下次追蹤日')),
        rawTranscript: cleanField(get('原始逐字稿')),
      };
    })
    .filter(v => v.visitId)
    .sort((a, b) => new Date(b.date.replace(/\//g,'-')) - new Date(a.date.replace(/\//g,'-')));

  let lastVisitDays = null;
  if (visits.length > 0 && visits[0].date) {
    const last = new Date(visits[0].date.replace(/\//g, '-'));
    if (!isNaN(last)) {
      lastVisitDays = Math.floor((new Date() - last) / 86400000);
    }
  }

  return json({ ok: true, pharmacyId, visitCount: visits.length, lastVisitDays, visits: visits.slice(0, 10) });
}

// ============================================================
// 4b. 所有拜訪紀錄（依日期排序）
// ============================================================
async function handleAllVisits(env) {
  const sheetId = env.SHEET_VISIT;
  const sheetName = '拜訪紀錄表';
  const url = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:json&sheet=${encodeURIComponent(sheetName)}`;

  const res = await fetch(url);
  const text = await res.text();
  const jsonStr = text.replace(/^.*?({.*}).*$/s, '$1');
  const data = JSON.parse(jsonStr);

  const rows = data?.table?.rows || [];
  const cols = data?.table?.cols || [];
  const colMap = {};
  cols.forEach((c, i) => { colMap[c.label] = i; });

  function parseGvizDate(val) {
    if (!val) return '';
    const m = String(val).match(/Date\((\d+),(\d+),(\d+)\)/);
    if (m) return `${m[1]}/${parseInt(m[2])+1}/${m[3]}`;
    return String(val);
  }

  function cleanField(val) {
    const s = String(val || '');
    if (s.match(/^\[L.*@[0-9a-f]+$/)) return '';
    return s;
  }

  const visits = rows
    .map(row => {
      const get = (label) => row.c[colMap[label]]?.v ?? '';
      const visitId = cleanField(get('Visit ID'));
      if (!visitId) return null;
      return {
        visitId,
        pharmacyId:  cleanField(get('店名')),
        date:        parseGvizDate(row.c[colMap['拜訪日期']]?.v || ''),
        purpose:     cleanField(get('拜訪目的')),
        summary:     cleanField(get('Summary')),
        content:     cleanField(get('拜訪內容')),
        actionItems: cleanField(get('Action Items')),
        painPoints:  cleanField(get('Pain Points')),
        tags:        cleanField(get('Tags')),
        nextFollow:  parseGvizDate(get('下次追蹤日')),
        rawTranscript: cleanField(get('原始逐字稿')),
      };
    })
    .filter(v => v && v.visitId && v.date)
    .sort((a, b) => new Date(b.date.replace(/\//g,'-')) - new Date(a.date.replace(/\//g,'-')))
    .slice(0, 500);

  return json({ ok: true, count: visits.length, visits });
}

// ============================================================
// 4c. AI 分析拜訪紀錄待辦事項
// ============================================================
async function handleAnalyzeTasks(request, env) {
  const body = await request.json();
  const { visits } = body;

  if (!visits || !visits.length) return json({ error: '缺少拜訪紀錄' }, 400);

  // 建立 visitId → 拜訪日期/藥局名 對照表，供後續連結用
  const visitMeta = {};
  visits.forEach(v => {
    if (v.visitId) visitMeta[v.visitId] = { date: v.date, pharmacyId: v.pharmacyId, pharmacyName: v.pharmacyName };
  });

  const notesText = visits.slice(0, 30).map(v =>
    `[visitId:${v.visitId}]【${v.date}】${v.pharmacyId ? v.pharmacyId + '（' + (v.pharmacyName||'') + '）' : ''}${v.purpose ? '目的：' + v.purpose + '。' : ''}${v.summary || v.content || ''}${v.actionItems ? '（待辦：' + v.actionItems + '）' : ''}`
  ).join('\n');

  const prompt = `你是業務助理AI，分析以下拜訪紀錄，提取具體的待辦事項。

情境對照規則：
- 「代班送貨」「幫爸爸送」「代送」→ 任務：歸還紅單給爸爸（藥局名）
- 「自己送貨」「自送」「親自出貨」→ 任務：拿回出貨紅單（藥局名）
- 「下週拜訪」「下次再來」「改天再談」→ 任務：安排下次拜訪 藥局名
- 「記得帶樣品」「帶資料」「帶XX」→ 任務：準備[物品]帶去 藥局名
- Action Items 欄位有內容 → 直接轉換為待辦任務
- 待追蹤、待確認的事項 → 轉換為任務

拜訪紀錄（每行開頭的 [visitId:xxx] 是該筆紀錄的 ID，請原樣放入輸出）：
${notesText}

請輸出 JSON 陣列（最多10項最重要的），無待辦則回傳 []：
[{"task":"完整任務描述（含藥局名）","type":"return_receipt|get_receipt|revisit|prepare|follow_up|other","priority":"high|medium|low","pharmacyId":"藥局ID","pharmacyName":"藥局名稱","sourceVisitId":"對應的visitId"}]

只輸出純 JSON，不要 markdown 或說明文字。`;

  const geminiRes = await fetch(`${GEMINI_URL}?key=${env.GEMINI_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: 800, temperature: 0.2 }
    })
  });

  const geminiData = await geminiRes.json();
  if (!geminiRes.ok) return json({ error: `Gemini 錯誤：${geminiData?.error?.message}` }, 500);

  const rawText = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || '[]';
  let tasks = [];
  try {
    const cleaned = rawText.replace(/```json\n?/g,'').replace(/```\n?/g,'').trim();
    tasks = JSON.parse(cleaned);
    if (!Array.isArray(tasks)) tasks = [];
    // 補充 sourceVisitDate
    tasks = tasks.map(t => {
      const meta = t.sourceVisitId ? visitMeta[t.sourceVisitId] : null;
      return { ...t, sourceVisitDate: meta?.date || null };
    });
  } catch { tasks = []; }

  return json({ ok: true, tasks });
}

// ============================================================
// 5. 所有藥局拜訪摘要
// ============================================================
// 「未建檔店家」暫存代號 → 正式 Customer_ID 對照表（已轉正欄非空才列入）。
// 2026-10-27：木木好藥局（暫存代號 f3e4049d69）轉正成 C137 之後，不改拜訪紀錄表本身的歷史列
// （避免動到原始資料），改成讀取時合併——之後任何暫存店家轉正都走同一套機制，不用再寫一次性腳本改歷史列。
async function fetchTempPharmacyConversionMap_(env) {
  const sheetId = env.SHEET_PHARMACY;
  const sheetName = '未建檔店家';
  const url = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:json&sheet=${encodeURIComponent(sheetName)}`;

  const res = await fetch(url);
  const text = await res.text();
  const jsonStr = text.replace(/^.*?({.*}).*$/s, '$1');
  const data = JSON.parse(jsonStr);

  const rows = data?.table?.rows || [];
  const cols = data?.table?.cols || [];
  const colMap = {};
  cols.forEach((c, i) => { colMap[c.label] = i; });

  const map = {};
  rows.forEach(row => {
    const tempId = row.c[colMap['id']]?.v || '';
    const convertedId = row.c[colMap['已轉正']]?.v || '';
    if (tempId && convertedId) map[tempId] = convertedId;
  });
  return map;
}

async function handleVisitsSummary(env) {
  const sheetId = env.SHEET_VISIT;
  const sheetName = '拜訪紀錄表';
  const url = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:json&sheet=${encodeURIComponent(sheetName)}`;

  const [res, conversionMap] = await Promise.all([
    fetch(url),
    fetchTempPharmacyConversionMap_(env),
  ]);
  const text = await res.text();
  const jsonStr = text.replace(/^.*?({.*}).*$/s, '$1');
  const data = JSON.parse(jsonStr);

  const rows = data?.table?.rows || [];
  const cols = data?.table?.cols || [];
  const colMap = {};
  cols.forEach((c, i) => { colMap[c.label] = i; });

  function parseGvizDate(val) {
    if (!val) return '';
    const m = String(val).match(/Date\((\d+),(\d+),(\d+)\)/);
    if (m) return `${m[1]}/${parseInt(m[2])+1}/${m[3]}`;
    return String(val);
  }

  const summary = {};
  rows.forEach(row => {
    let id      = row.c[colMap['店名']]?.v || '';
    const date = parseGvizDate(row.c[colMap['拜訪日期']]?.v || '');
    const tags = row.c[colMap['Tags']]?.v || '';
    const actionItems = row.c[colMap['Action Items']]?.v || '';
    if (!id) return;
    if (conversionMap[id]) id = conversionMap[id]; // 暫存代號已轉正：合併進正式 Customer_ID

    if (!summary[id]) {
      summary[id] = { lastDate: '', visitCount: 0, hasPending: false };
    }
    summary[id].visitCount++;
    if (!summary[id].lastDate || date > summary[id].lastDate) {
      summary[id].lastDate = date;
    }
    if (tags.includes('#待') || tags.includes('#追蹤') || actionItems) {
      summary[id].hasPending = true;
    }
  });

  const today = new Date();
  const result = {};
  Object.entries(summary).forEach(([id, v]) => {
    const last = new Date(v.lastDate.replace(/\//g, '-'));
    const daysSince = isNaN(last) ? null : Math.floor((today - last) / 86400000);
    result[id] = {
      lastDate:   v.lastDate,
      daysSince,
      visitCount: v.visitCount,
      hasPending: v.hasPending,
      overdue:    daysSince !== null && daysSince > 7,
    };
  });

  return json({ ok: true, count: Object.keys(result).length, summary: result });
}

// ============================================================
// 6. 所有藥局叫貨金額統計
// ============================================================
async function handleOrdersSummary(env) {
  const sheetId = env.SHEET_ORDER;
  const url = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:json`;

  const res = await fetch(url);
  const text = await res.text();
  const jsonStr = text.replace(/^.*?({.*}).*$/s, '$1');
  const data = JSON.parse(jsonStr);

  const rows = data?.table?.rows || [];
  const cols = data?.table?.cols || [];
  const colMap = {};
  cols.forEach((c, i) => { colMap[c.label] = i; });

  const summary = {};
  rows.forEach(row => {
    const id     = row.c[colMap['店名_備份']]?.v || '';
    const amount = parseFloat(row.c[colMap['小計']]?.v || 0);
    if (!id) return;
    if (!summary[id]) summary[id] = { totalAmount: 0, orderCount: 0, lastOrder: '' };
    summary[id].totalAmount += amount;
    summary[id].orderCount++;
  });

  return json({ ok: true, count: Object.keys(summary).length, summary });
}

// ============================================================
// 7. AI 推薦今日行程
// ============================================================
async function handleRecommendToday(env) {
  const [pharmaciesRes, visitsRes, ordersRes] = await Promise.all([
    handleGetPharmacies(null, env).then(r => r.json()),
    handleVisitsSummary(env).then(r => r.json()),
    handleOrdersSummary(env).then(r => r.json()),
  ]);

  const pharmacies  = pharmaciesRes.pharmacies || [];
  const visitMap    = visitsRes.summary || {};
  const orderMap    = ordersRes.summary || {};

  const scored = pharmacies.map(p => {
    const v = visitMap[p.id] || {};
    const o = orderMap[p.id] || {};

    const daysSince   = v.daysSince ?? 999;
    const totalAmount = o.totalAmount || 0;
    const hasPending  = v.hasPending || false;
    const neverOrdered = !o.orderCount;
    const neverVisited = !v.visitCount;

    // 死客戶直接讀主表「停用」欄（p.deadReason），不再用天數/金額猜測——
    // 舊的猜測規則對「老爸」的客戶不準（這套系統沒追蹤到老爸的拜訪/叫貨資料），
    // 現在欄位是真實標記，不需要再排除老爸的客戶
    if (p.deadReason) return null;

    let score = 0;

    if (daysSince > 60)      score += 80;
    else if (daysSince > 30) score += 60;
    else if (daysSince > 14) score += 40;
    else if (daysSince > 7)  score += 20;

    if (totalAmount > 20000)      score += 30;
    else if (totalAmount > 10000) score += 20;
    else if (totalAmount > 5000)  score += 10;

    if (hasPending)  score += 25;
    if (neverVisited) score += 15;
    if (neverOrdered) score += 10;

    return {
      id:          p.id,
      name:        p.name,
      address:     p.address,
      lat:         p.lat,
      lng:         p.lng,
      pharmacist:  p.pharmacist,
      district:    p.district,
      score,
      daysSince:   daysSince === 999 ? null : daysSince,
      lastDate:    v.lastDate || null,
      totalAmount,
      hasPending,
      neverVisited,
      reason:      buildReason(daysSince, totalAmount, hasPending, neverVisited),
    };
  })
  .filter(p => p !== null)
  .sort((a, b) => b.score - a.score);

  const top10 = scored.slice(0, 10);

  return json({
    ok: true,
    total: pharmacies.length,
    recommended: top10,
    all: scored,          // 全部藥局（含計畫內不在前10的）
    generatedAt: new Date().toISOString(),
  });
}

function buildReason(daysSince, totalAmount, hasPending, neverVisited) {
  const reasons = [];
  if (daysSince > 60)      reasons.push(`⚠️ ${daysSince} 天未訪`);
  else if (daysSince > 14) reasons.push(`📅 ${daysSince} 天未訪`);
  if (hasPending)          reasons.push('📌 有待追蹤事項');
  if (totalAmount > 10000) reasons.push(`💰 高價值客戶（$${totalAmount.toLocaleString()}）`);
  if (neverVisited)        reasons.push('🆕 從未拜訪');
  return reasons.join('、') || '例行拜訪';
}

// ============================================================
// 8. 客戶狀態管理（死客戶，2026-10-24 改讀寫主表「停用」欄，見檔頭【/customer-status】）
// ============================================================
async function handleCustomerStatus(request, env) {
  if (request.method === 'GET') {
    const res = await handleGetPharmacies(null, env);
    const data = await res.json();
    const statuses = {};
    (data.pharmacies || []).forEach(p => {
      if (p.deadReason) statuses[p.id] = { status: 'dead', note: p.deadReason };
    });
    return json({ ok: true, statuses });
  }

  if (request.method === 'POST') {
    const body = await request.json();
    const { id, status, note } = body;
    if (!id) return json({ error: '缺少 id' }, 400);
    const value = status === 'dead' ? (note || '死客戶') : '';
    const res = await fetch(GAS_VISIT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'updatePharmacyFlag', id, field: 'dead', value }),
      redirect: 'follow',
    });
    const data = await res.json();
    return json({ ok: !!data.success, ...data });
  }

  return json({ error: '不支援此 method' }, 405);
}

// ============================================================
// 9. 業務待辦清單（代理到 Google Apps Script）
// ============================================================
async function handleTodos(request) {
  if (request.method === 'GET') {
    const res = await fetch(`${GAS_URL}?action=getTodos`, { redirect: 'follow' });
    const data = await res.json();
    return json(data);
  }

  if (request.method === 'POST') {
    const body = await request.json();
    const res = await fetch(GAS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      redirect: 'follow',
    });
    const data = await res.json();
    return json(data);
  }

  return json({ error: '不支援此 method' }, 405);
}

// ============================================================
// 10. 新版待辦清單（Cloudflare KV 持久化）
// ============================================================
const TODOS_KV_KEY = 'todos:all';

async function handleTodosV2(request, env) {
  const kv = env.TODOS_KV;
  if (!kv) return json({ error: 'KV binding 未設定' }, 500);

  // GET — 讀取全部
  if (request.method === 'GET') {
    const raw = await kv.get(TODOS_KV_KEY);
    const todos = raw ? JSON.parse(raw) : [];
    return json({ todos });
  }

  // POST — 新增一筆
  if (request.method === 'POST') {
    const body = await request.json();
    const raw = await kv.get(TODOS_KV_KEY);
    const todos = raw ? JSON.parse(raw) : [];
    const newTodo = {
      id: `todo_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      task: body.task || '',
      quadrant: body.quadrant || 'pool',
      pharmacyId: body.pharmacyId || '',
      pharmacyName: body.pharmacyName || '',
      scheduledDate: body.scheduledDate || null,
      done: false,
      doneAt: null,
      aiSuggestions: body.aiSuggestions || [],
      resolution: '',
      relatedTodoIds: [],
      sourceVisitId: body.sourceVisitId || null,
      sourceVisitDate: body.sourceVisitDate || null,
      type: body.type || 'other',
      newPhAddress: body.newPhAddress || '',
      newPhCity: body.newPhCity || '',
      healthInsurance: body.healthInsurance || '',
      source: body.source || '',
      createdAt: new Date().toISOString(),
    };
    todos.push(newTodo);
    await kv.put(TODOS_KV_KEY, JSON.stringify(todos));
    return json({ ok: true, todo: newTodo });
  }

  // PUT — 更新一筆（部分更新）
  if (request.method === 'PUT') {
    const body = await request.json();
    if (!body.id) return json({ error: '缺少 id' }, 400);
    const raw = await kv.get(TODOS_KV_KEY);
    const todos = raw ? JSON.parse(raw) : [];
    const idx = todos.findIndex(t => t.id === body.id);
    if (idx === -1) return json({ error: '找不到此待辦' }, 404);

    const updated = { ...todos[idx] };
    const allowedFields = ['task','quadrant','pharmacyId','pharmacyName','scheduledDate','done','doneAt','aiSuggestions','resolution','relatedTodoIds','sourceVisitId','sourceVisitDate','type','source'];
    for (const f of allowedFields) {
      if (body[f] !== undefined) updated[f] = body[f];
    }
    if (body.done === true && !updated.doneAt) updated.doneAt = new Date().toISOString();
    if (body.done === false) updated.doneAt = null;
    todos[idx] = updated;
    await kv.put(TODOS_KV_KEY, JSON.stringify(todos));
    return json({ ok: true, todo: updated });
  }

  // DELETE — 刪除一筆
  if (request.method === 'DELETE') {
    const url = new URL(request.url);
    const id = url.searchParams.get('id');
    if (!id) return json({ error: '缺少 id' }, 400);
    const raw = await kv.get(TODOS_KV_KEY);
    let todos = raw ? JSON.parse(raw) : [];
    todos = todos.filter(t => t.id !== id);
    await kv.put(TODOS_KV_KEY, JSON.stringify(todos));
    return json({ ok: true });
  }

  return json({ error: '不支援此 method' }, 405);
}

// ============================================================
// 11. AI 待辦建議（Gemini）
// ============================================================
async function handleAiTodoSuggest(request, env) {
  const { pharmacyName, task } = await request.json();
  if (!task) return json({ error: '缺少 task' }, 400);

  const prompt = `你是藥局業務助理。請根據以下待辦事項，輸出 JSON（不要 markdown）：

藥局：${pharmacyName || '（未指定）'}
待辦事項：${task}

艾森豪矩陣判斷規則：
- ui（緊急重要）：今天就要做、客戶在等、影響業績的事，如當日調貨、緊急客訴、今日送藥
- ii（重要不緊急）：影響業績但有時間規劃，如定期拜訪、提案準備、關係維護
- iii（緊急不重要）：有時效但不影響業績，如交辦文件、例行回報、轉達訊息
- iv（不緊急不重要）：可延後或刪除，如資料整理、非必要瑣事
- pool（待辦池）：優先級不明確、需要再評估，或目前無法判斷的事項

輸出 JSON：
{"suggestedQuadrant":"ui|ii|iii|iv|pool","suggestions":["準備事項1","準備事項2","準備事項3"]}

suggestions 列 2~4 條具體要準備的事，不要編號。只輸出純 JSON。`;

  const geminiRes = await fetch(`${GEMINI_URL}?key=${env.GEMINI_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: 400, temperature: 0.3 }
    })
  });
  const geminiData = await geminiRes.json();
  if (!geminiRes.ok) return json({ error: `Gemini 錯誤：${geminiData?.error?.message}` }, 500);

  const raw = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  let suggestedQuadrant = 'pool';
  let suggestions = [];
  try {
    const cleaned = raw.replace(/```json\n?/g,'').replace(/```\n?/g,'').trim();
    const parsed = JSON.parse(cleaned);
    suggestedQuadrant = parsed.suggestedQuadrant || 'pool';
    suggestions = Array.isArray(parsed.suggestions) ? parsed.suggestions : [];
  } catch {
    // fallback: 純文字處理
    suggestions = raw.split('\n').map(s => s.trim()).filter(s => s.length > 0);
  }
  return json({ ok: true, suggestedQuadrant, suggestions });
}

// ============================================================
// 12. 藥局名稱偵測（字串比對，不耗 Gemini quota）
// ============================================================
async function handlePharmacyDetect(request) {
  const { text, pharmacyList } = await request.json();
  if (!text || !Array.isArray(pharmacyList)) return json({ found: [] });
  const found = pharmacyList.filter(name => name && text.includes(name));
  return json({ found: [...new Set(found)] });
}

// ============================================================
// 13. 新增拜訪紀錄（代理到 GAS）
// ============================================================
async function handleAddVisit(request) {
  const body = await request.json();
  // 轉換欄位名稱以符合 VisitAppWebhook.js 格式
  const gasPayload = {
    action:      'addVisit',
    visitId:     body.visitId,
    pharmacy:    body.pharmacyName || body.pharmacy || '',
    date:        body.date,
    visitType:   body.purpose || body.visitType || '',
    note:        body.content  || body.note || '',
  };
  const res = await fetch(GAS_VISIT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(gasPayload),
    redirect: 'follow',
  });
  const data = await res.json();
  return json(data);
}

// ============================================================
// 14. 產品清單
// ============================================================
async function handleGetProducts(env) {
  const sheetId = env.SHEET_PRODUCT;
  const url = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:json`;
  const res = await fetch(url);
  const text = await res.text();
  const jsonStr = text.replace(/^.*?({.*}).*$/s, '$1');
  const data = JSON.parse(jsonStr);

  const rows = data?.table?.rows || [];
  const cols = data?.table?.cols || [];
  const colNames = cols.map(c => c.label);

  const candidates = ['品名', '產品名稱', '商品名稱', '藥品名稱', '產品', '藥品', '品項'];
  const productColIdx = cols.findIndex(c => candidates.includes(c.label));

  if (productColIdx === -1) {
    return json({ ok: false, columns: colNames, products: [], error: '找不到品名欄位，請確認欄位名稱' });
  }

  const products = [...new Set(
    rows.map(r => String(r.c[productColIdx]?.v || '')).filter(Boolean)
  )].sort();

  return json({ ok: true, products, productCol: cols[productColIdx].label, columns: colNames });
}

// ============================================================
// 15. 依產品查詢進貨藥局（精準比對 產品編號2，支援時間篩選）
// ============================================================
async function handleProductOrders(request, env) {
  const reqUrl = new URL(request.url);
  const product = reqUrl.searchParams.get('product') || '';
  // months=0 代表不限時間，預設 12 個月
  const months  = parseInt(reqUrl.searchParams.get('months') || '12', 10);
  if (!product) return json({ error: '缺少 product 參數' }, 400);

  const [prodRes, orderRes] = await Promise.all([
    fetch(`https://docs.google.com/spreadsheets/d/${env.SHEET_PRODUCT}/gviz/tq?tqx=out:json`),
    fetch(`https://docs.google.com/spreadsheets/d/${env.SHEET_ORDER}/gviz/tq?tqx=out:json`),
  ]);

  function parseGviz(text) {
    const jsonStr = text.replace(/^.*?({.*}).*$/s, '$1');
    const data = JSON.parse(jsonStr);
    const cols = data?.table?.cols || [];
    const rows = data?.table?.rows || [];
    const colMap = {};
    cols.forEach((c, i) => { colMap[c.label] = i; });
    return { rows, cols, colMap };
  }

  const prodData  = parseGviz(await prodRes.text());
  const orderData = parseGviz(await orderRes.text());

  const nameCol  = ['產品名稱','品名','商品名稱','藥品名稱'].find(n => prodData.colMap[n] !== undefined);
  const idCol2   = prodData.colMap['產品編號2'] !== undefined ? '產品編號2' : null; // 精準 ID，如 "8A"

  if (!nameCol) return json({ ok: false, result: [], error: '產品清單找不到名稱欄位' });
  if (!idCol2)  return json({ ok: false, result: [], error: '產品清單找不到產品編號2欄位' });

  // 收集符合名稱的所有 產品編號2（精準 set，如 {"8A","8B","8C"}）
  const matchedIds = new Set();  // 精準 ID
  const idToName   = {};         // "8A" → "優樂寧"
  prodData.rows.forEach(row => {
    const name = String(row.c[prodData.colMap[nameCol]]?.v || '');
    if (!name.includes(product)) return;
    const pid2 = String(row.c[prodData.colMap[idCol2]]?.v || '').trim();
    if (pid2) { matchedIds.add(pid2); idToName[pid2] = name; }
  });

  if (!matchedIds.size) {
    return json({ ok: true, product, result: [], hasDate: false, note: '產品清單中找不到符合的品名' });
  }

  // 時間截止點
  const cutoff = months > 0
    ? new Date(Date.now() - months * 30 * 86400000).toISOString().slice(0, 10)
    : '';

  // 訂單編號格式：YYMMDDNN → 2026-01-12
  function extractDate(orderNo) {
    const s = String(orderNo || '').replace(/\D/g, '');
    if (s.length >= 6) {
      const yy = parseInt(s.slice(0, 2), 10);
      const mm = parseInt(s.slice(2, 4), 10);
      const dd = parseInt(s.slice(4, 6), 10);
      if (yy >= 10 && yy <= 99 && mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) {
        return `${2000 + yy}-${String(mm).padStart(2,'0')}-${String(dd).padStart(2,'0')}`;
      }
    }
    const m = String(orderNo || '').match(/(\d{4})-(\d{2})-(\d{2})/);
    return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
  }

  const oMap = orderData.colMap;
  const pharmacyMap = {};

  orderData.rows.forEach(row => {
    const prodId = String(row.c[oMap['產品ID']]?.v || '').trim();
    if (!matchedIds.has(prodId)) return;   // ← 精準比對，不再只看前綴

    const pharmacy = row.c[oMap['店名_備份']]?.v || '';
    if (!pharmacy) return;

    const date = extractDate(row.c[oMap['訂單編號']]?.v || '');
    if (cutoff && date && date < cutoff) return;  // 時間篩選

    const qty    = parseFloat(row.c[oMap['數量']]?.v || 0);
    const amount = parseFloat(row.c[oMap['小計']]?.v || 0);

    if (!pharmacyMap[pharmacy]) pharmacyMap[pharmacy] = { pharmacyId: pharmacy, totalQty: 0, totalAmount: 0, orderNos: new Set(), dates: new Set(), prodName: '' };
    pharmacyMap[pharmacy].totalQty    += qty;
    pharmacyMap[pharmacy].totalAmount += amount;
    pharmacyMap[pharmacy].prodName     = idToName[prodId] || product;
    const orderNo = row.c[oMap['訂單編號']]?.v;
    if (orderNo) pharmacyMap[pharmacy].orderNos.add(String(orderNo));
    if (date) pharmacyMap[pharmacy].dates.add(date);
  });

  const result = Object.values(pharmacyMap)
    .map(p => ({
      pharmacyId:  p.pharmacyId,
      prodName:    p.prodName,
      orderCount:  p.orderNos.size,
      totalQty:    p.totalQty,
      totalAmount: p.totalAmount,
      lastDate:    [...p.dates].sort().reverse()[0] || '',
    }))
    .sort((a, b) => (b.lastDate > a.lastDate ? 1 : -1));

  const hasDate = result.some(r => r.lastDate);
  return json({ ok: true, product, result, hasDate, months, matchedIds: [...matchedIds] });
}

// ============================================================
// 16. 月曆計畫（KV 持久化）
// ============================================================
async function handleCalendarPlan(request, env) {
  if (request.method === 'GET') {
    const raw = await env.TODOS_KV.get('calendar:plan');
    return json({ ok: true, plan: raw ? JSON.parse(raw) : {} });
  }
  if (request.method === 'PUT') {
    const body = await request.json();
    await env.TODOS_KV.put('calendar:plan', JSON.stringify(body.plan || {}));
    return json({ ok: true });
  }
  return json({ error: '不支援此 method' }, 405);
}

// ============================================================
// 17. 爸爸客戶清單（2026-10-24 改讀寫主表「負責人」欄，見檔頭【/dad-pharmacies】）
// ============================================================
async function handleDadPharmacies(request, env) {
  if (request.method === 'GET') {
    const res = await handleGetPharmacies(null, env);
    const data = await res.json();
    const ids = (data.pharmacies || []).filter(p => p.owner === '老爸').map(p => p.id);
    return json({ ok: true, ids });
  }
  if (request.method === 'POST') {
    const body = await request.json();
    const { id, action } = body;
    if (!id || !action) return json({ error: '缺少 id 或 action' }, 400);
    if (action !== 'add' && action !== 'remove') return json({ error: 'action 必須是 add 或 remove' }, 400);
    const value = action === 'add' ? '老爸' : '';
    const writeRes = await fetch(GAS_VISIT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'updatePharmacyFlag', id, field: 'dad', value }),
      redirect: 'follow',
    });
    const writeData = await writeRes.json();
    if (!writeData.success) return json({ ok: false, error: writeData.error || '寫入失敗' }, 500);

    const res = await handleGetPharmacies(null, env);
    const data = await res.json();
    const ids = (data.pharmacies || []).filter(p => p.owner === '老爸').map(p => p.id);
    return json({ ok: true, ids });
  }
  return json({ error: '不支援此 method' }, 405);
}

// ============================================================
// 工具：解析 gviz 日期格式（"Date(2026,6,11)" 或 "2026/7/9"）
// ============================================================
function parseGvizDate(v) {
  if (!v) return '';
  const s = String(v);
  if (s.startsWith('Date(')) {
    const parts = s.slice(5, -1).split(',');
    const y = parseInt(parts[0]);
    const m = parseInt(parts[1]) + 1;
    const d = parseInt(parts[2]);
    return `${y}/${m}/${d}`;
  }
  return s;
}

// 判斷是否已到寄單時機：今月 >= 訂單月+7
function needsInvoicing(orderDateStr, now) {
  const parts = orderDateStr.split('/');
  if (parts.length < 2) return false;
  const orderYear = parseInt(parts[0]);
  const orderMonth = parseInt(parts[1]) - 1; // 0-indexed
  const threshold = new Date(orderYear, orderMonth + 7, 1);
  return now >= threshold;
}

// 共用：讀取訂單主檔所有列
async function fetchOrderMasterRows(env) {
  const sheetId = env.SHEET_ORDER_MASTER;
  if (!sheetId) throw new Error('未設定 SHEET_ORDER_MASTER');
  const url = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:json`;
  const res = await fetch(url);
  const text = await res.text();
  const jsonStr = text.replace(/^.*?({.*}).*$/s, '$1');
  const data = JSON.parse(jsonStr);
  const rows = data?.table?.rows || [];
  const cols = data?.table?.cols || [];
  const colMap = {};
  cols.forEach((c, i) => { colMap[c.label] = i; });
  return { rows, colMap };
}

// ============================================================
// 今日出貨清單
// ============================================================
async function handleTodayOrders(env) {
  const { rows, colMap } = await fetchOrderMasterRows(env);
  const today = new Date();
  const todayStr = `${today.getFullYear()}/${today.getMonth()+1}/${today.getDate()}`;
  const orders = [];
  rows.forEach(row => {
    const orderDate = parseGvizDate(row.c[colMap['訂單日期']]?.v || '');
    if (orderDate !== todayStr) return;
    const storeCode   = String(row.c[colMap['店名']]?.v || '').trim();
    const storeName   = String(row.c[colMap['店名_中文']]?.v || storeCode).trim();
    const totalAmount = parseFloat(row.c[colMap['總金額']]?.v || 0);
    const status      = String(row.c[colMap['紅單實體狀態']]?.v || '').trim();
    const orderNo     = String(row.c[colMap['訂單編號']]?.v || '').trim();
    if (!storeCode) return;
    orders.push({ orderNo, storeCode, storeName, totalAmount, status });
  });
  return json({ ok: true, date: todayStr, orders });
}

// ============================================================
// 帳務清單（寄單 + 請款）
// ============================================================
async function handleInvoiceTasks(env) {
  const { rows, colMap } = await fetchOrderMasterRows(env);
  const now = new Date();
  const invoicing  = [];
  const collection = [];
  rows.forEach(row => {
    const status      = String(row.c[colMap['紅單實體狀態']]?.v || '').trim();
    const storeCode   = String(row.c[colMap['店名']]?.v || '').trim();
    const storeName   = String(row.c[colMap['店名_中文']]?.v || storeCode).trim();
    const totalAmount = parseFloat(row.c[colMap['總金額']]?.v || 0);
    const orderNo     = String(row.c[colMap['訂單編號']]?.v || '').trim();
    const orderDate   = parseGvizDate(row.c[colMap['訂單日期']]?.v || '');
    if (!storeCode) return;
    if (status === '寄賣中(資料夾)') {
      if (orderDate && needsInvoicing(orderDate, now)) {
        invoicing.push({ orderNo, storeCode, storeName, totalAmount, orderDate });
      }
    } else if (status === '待請款(已寄單)') {
      collection.push({ orderNo, storeCode, storeName, totalAmount, orderDate });
    }
  });
  return json({ ok: true, invoicing, collection });
}

// ============================================================
// 18. 盤點候選產品清單
// ============================================================
// env 有帶且該 sheet 允許快取時，會用 KV 存 60 秒（Cloudflare KV 最短 TTL），
// 減少反覆打 Google gviz 的往返時間；不帶 env 就是原本每次即時讀取。
async function fetchGvizSheet(sheetId, sheetName, env) {
  const base = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:json`;
  const url = sheetName ? `${base}&sheet=${encodeURIComponent(sheetName)}` : base;
  const cacheKey = `gviz:${sheetId}:${sheetName || ''}`;

  if (env && env.TODOS_KV) {
    const cached = await env.TODOS_KV.get(cacheKey, 'json');
    if (cached) return cached;
  }

  const res = await fetch(url);
  const text = await res.text();
  const jsonStr = text.replace(/^.*?({.*}).*$/s, '$1');
  const data = JSON.parse(jsonStr);
  const cols = data?.table?.cols || [];
  const rows = data?.table?.rows || [];
  const colMap = {};
  cols.forEach((c, i) => { colMap[c.label] = i; });
  const result = { rows, colMap };

  if (env && env.TODOS_KV) {
    await env.TODOS_KV.put(cacheKey, JSON.stringify(result), { expirationTtl: 60 });
  }

  return result;
}

function gvizGet(row, colMap, label) {
  const i = colMap[label];
  if (i === undefined || !row.c[i]) return '';
  return row.c[i].v ?? '';
}

async function handleInventoryCandidates(request, env) {
  const reqUrl = new URL(request.url);
  const pharmacy = reqUrl.searchParams.get('pharmacy') || '';
  const session  = reqUrl.searchParams.get('session') || '';
  if (!pharmacy) return json({ error: '缺少 pharmacy 參數' }, 400);

  const [orderData, returnData, returnOrderData, productData] = await Promise.all([
    fetchGvizSheet(env.SHEET_ORDER, null, env),
    fetchGvizSheet(env.SHEET_RETURN, null, env),
    fetchGvizSheet(env.SHEET_RETURN_ORDER, null, env),
    fetchGvizSheet(env.SHEET_PRODUCT, null, env),
  ]);

  // 產品主檔：產品編號2 → 名稱/分類/包裝
  const productMap = {};
  productData.rows.forEach(row => {
    const pid2 = String(gvizGet(row, productData.colMap, '產品編號2') || '').trim();
    if (!pid2) return;
    productMap[pid2] = {
      name:     String(gvizGet(row, productData.colMap, '產品名稱') || ''),
      category: String(gvizGet(row, productData.colMap, '小分類名稱') || ''),
      pack:     String(gvizGet(row, productData.colMap, '包裝') || ''),
    };
  });

  // 退貨單號 → 店名（Customer_ID），用來把退貨明細對應到特定藥局
  const returnOrderStoreMap = {};
  returnOrderData.rows.forEach(row => {
    const no    = String(gvizGet(row, returnOrderData.colMap, '退貨單號') || '').trim();
    const store = String(gvizGet(row, returnOrderData.colMap, '店名') || '').trim();
    if (no && store) returnOrderStoreMap[no] = store;
  });

  // 停售產品（單店排除：退貨原因=停售，且該筆退貨單對應到目前這家藥局）
  const discontinued = new Set();
  returnData.rows.forEach(row => {
    const reason = gvizGet(row, returnData.colMap, '退貨原因');
    if (reason !== '停售') return;
    const returnNo = String(gvizGet(row, returnData.colMap, '退貨單號') || '').trim();
    if (returnOrderStoreMap[returnNo] !== pharmacy) return;
    const pid = String(gvizGet(row, returnData.colMap, '產品ID') || '').trim();
    if (pid) discontinued.add(pid);
  });

  // 這家藥局買過的產品
  const bought = {}; // pid -> { totalQty }
  orderData.rows.forEach(row => {
    const store = String(gvizGet(row, orderData.colMap, '店名_備份') || '').trim();
    if (store !== pharmacy) return;
    const pid = String(gvizGet(row, orderData.colMap, '產品ID') || '').trim();
    if (!pid) return;
    const qty = parseFloat(gvizGet(row, orderData.colMap, '數量')) || 0;
    if (!bought[pid]) bought[pid] = { totalQty: 0 };
    bought[pid].totalQty += qty;
  });

  // 排除這個場次已經記錄的（帶 session 時才查，查不到就略過不影響主邏輯）
  const alreadyRecorded = new Set();
  if (session && env.SHEET_INVENTORY) {
    try {
      const detailData = await fetchGvizSheet(env.SHEET_INVENTORY, '盤點明細');
      detailData.rows.forEach(row => {
        const rowSession = String(gvizGet(row, detailData.colMap, '盤點編號') || '').trim();
        if (rowSession !== session) return;
        const pid = String(gvizGet(row, detailData.colMap, '產品ID') || '').trim();
        if (pid) alreadyRecorded.add(pid);
      });
    } catch (e) {
      console.error('讀取盤點明細失敗（不影響候選清單主邏輯）:', e);
    }
  }

  const candidates = Object.keys(bought)
    .filter(pid => !discontinued.has(pid) && !alreadyRecorded.has(pid))
    .map(pid => {
      const p = productMap[pid] || {};
      return {
        productId:       pid,
        productName:     p.name || pid,
        category:        p.category || '',
        pack:            p.pack || '',
        totalQtyOrdered: bought[pid].totalQty,
        photoUrl:        `/product-photo/${encodeURIComponent(pid)}.jpg`,
      };
    })
    .sort((a, b) => (a.category + a.productName).localeCompare(b.category + b.productName, 'zh-Hant'));

  return json({ ok: true, pharmacy, count: candidates.length, candidates });
}

// ============================================================
// 19. 盤點批次寫入（代理到 GAS，寫入盤點主檔 + 盤點明細）
// ============================================================
async function handleInventorySubmit(request, env) {
  const body = await request.json();
  const { pharmacyId, items, visitDate, visitId } = body;
  if (!pharmacyId || !Array.isArray(items) || !items.length) {
    return json({ error: '缺少 pharmacyId 或 items' }, 400);
  }

  const now = new Date();
  const dateStr = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  const sessionId = `INV-${dateStr}-${Math.random().toString(16).slice(2, 10)}`;

  const gasPayload = {
    action:         'inventorySubmit',
    sessionId,
    visitId:        visitId || '',
    customerId:     pharmacyId,
    inventoryDate:  visitDate || `${now.getFullYear()}/${now.getMonth() + 1}/${now.getDate()}`,
    items: items.map(it => ({
      productId:   it.productId || '',
      productName: it.productName || '',
      qty:         it.qty,
      note:        it.note || '',
      expiry:      it.expiry || '',
    })),
  };

  const res = await fetch(GAS_VISIT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(gasPayload),
    redirect: 'follow',
  });
  const data = await res.json();
  if (!data.success) return json({ error: data.error || 'GAS 寫入失敗' }, 500);
  return json({ ok: true, sessionId, itemCount: data.itemCount });
}

// ============================================================
// 20. 產品照片（從 Cloudflare R2 讀取）
// ============================================================
async function handleProductPhoto(key, env) {
  if (!env.PRODUCT_PHOTOS) return json({ error: 'R2 binding 未設定' }, 500);
  const obj = await env.PRODUCT_PHOTOS.get(key);
  if (!obj) return new Response('Not Found', { status: 404, headers: { ...CORS_HEADERS, 'Content-Type': 'text/plain' } });
  const headers = new Headers(CORS_HEADERS);
  headers.set('Content-Type', obj.httpMetadata?.contentType || 'image/jpeg');
  headers.set('Cache-Control', 'public, max-age=2592000');
  return new Response(obj.body, { headers });
}

// ============================================================
// 21. 藥局資訊總覽（出貨明細 + 退貨紀錄 + 盤點歷史，依 pharmacy 彙整）
// ============================================================
function extractOrderDateFromNo(orderNo) {
  const s = String(orderNo || '').replace(/\D/g, '');
  if (s.length >= 6) {
    const yy = parseInt(s.slice(0, 2), 10);
    const mm = parseInt(s.slice(2, 4), 10);
    const dd = parseInt(s.slice(4, 6), 10);
    if (yy >= 10 && yy <= 99 && mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) {
      return `${2000 + yy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
    }
  }
  const m = String(orderNo || '').match(/(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
}

async function handlePharmacyProfile(request, env) {
  const reqUrl = new URL(request.url);
  const pharmacy = reqUrl.searchParams.get('pharmacy') || '';
  if (!pharmacy) return json({ error: '缺少 pharmacy 參數' }, 400);

  const [orderData, productData, returnDetailData, returnOrderData, invMasterData, invDetailData] = await Promise.all([
    fetchGvizSheet(env.SHEET_ORDER, null, env),
    fetchGvizSheet(env.SHEET_PRODUCT, null, env),
    fetchGvizSheet(env.SHEET_RETURN, null, env),
    fetchGvizSheet(env.SHEET_RETURN_ORDER, null, env),
    fetchGvizSheet(env.SHEET_INVENTORY, '盤點主檔'),
    fetchGvizSheet(env.SHEET_INVENTORY, '盤點明細'),
  ]);

  const productNameMap = {};
  productData.rows.forEach(row => {
    const pid = String(gvizGet(row, productData.colMap, '產品編號2') || '').trim();
    if (pid) productNameMap[pid] = String(gvizGet(row, productData.colMap, '產品名稱') || '');
  });

  // ── 出貨/訂單明細 ──
  const orders = [];
  orderData.rows.forEach(row => {
    const store = String(gvizGet(row, orderData.colMap, '店名_備份') || '').trim();
    if (store !== pharmacy) return;
    const orderNo = gvizGet(row, orderData.colMap, '訂單編號');
    const pid = String(gvizGet(row, orderData.colMap, '產品ID') || '').trim();
    orders.push({
      orderNo:     String(orderNo || ''),
      date:        extractOrderDateFromNo(orderNo),
      productId:   pid,
      productName: productNameMap[pid] || pid,
      qty:         parseFloat(gvizGet(row, orderData.colMap, '數量')) || 0,
      unitPrice:   parseFloat(gvizGet(row, orderData.colMap, '單價')) || 0,
      subtotal:    parseFloat(gvizGet(row, orderData.colMap, '小計')) || 0,
    });
  });
  orders.sort((a, b) => (b.date > a.date ? 1 : (b.date < a.date ? -1 : 0)));

  // ── 退貨紀錄（退貨單=主檔，退貨明細=明細，透過退貨單號 join，只取這家店的） ──
  const myReturnOrders = {};
  returnOrderData.rows.forEach(row => {
    const store = String(gvizGet(row, returnOrderData.colMap, '店名') || '').trim();
    if (store !== pharmacy) return;
    const no = String(gvizGet(row, returnOrderData.colMap, '退貨單號') || '').trim();
    if (!no) return;
    myReturnOrders[no] = {
      returnNo: no,
      date:     parseGvizDate(gvizGet(row, returnOrderData.colMap, '退貨日期')),
      amount:   parseFloat(gvizGet(row, returnOrderData.colMap, '退貨金額')) || 0,
      status:   String(gvizGet(row, returnOrderData.colMap, '退貨單實體狀態') || ''),
      items:    [],
    };
  });
  returnDetailData.rows.forEach(row => {
    const no = String(gvizGet(row, returnDetailData.colMap, '退貨單號') || '').trim();
    const master = myReturnOrders[no];
    if (!master) return;
    const pid = String(gvizGet(row, returnDetailData.colMap, '產品ID') || '').trim();
    master.items.push({
      productId:   pid,
      productName: productNameMap[pid] || pid,
      qty:         parseFloat(gvizGet(row, returnDetailData.colMap, '數量')) || 0,
      unitPrice:   parseFloat(gvizGet(row, returnDetailData.colMap, '退貨單價')) || 0,
      subtotal:    parseFloat(gvizGet(row, returnDetailData.colMap, '小計')) || 0,
      reason:      String(gvizGet(row, returnDetailData.colMap, '退貨原因') || ''),
      note:        String(gvizGet(row, returnDetailData.colMap, '退貨備註') || ''),
    });
  });
  const returns = Object.values(myReturnOrders).sort((a, b) => (b.date > a.date ? 1 : (b.date < a.date ? -1 : 0)));

  // ── 盤點歷史（盤點主檔=場次，盤點明細=品項，透過盤點編號 join，只取這家店的） ──
  const mySessions = {};
  invMasterData.rows.forEach(row => {
    const cust = String(gvizGet(row, invMasterData.colMap, 'Customer_ID') || '').trim();
    if (cust !== pharmacy) return;
    const sid = String(gvizGet(row, invMasterData.colMap, '盤點編號') || '').trim();
    if (!sid) return;
    mySessions[sid] = {
      sessionId: sid,
      date:      parseGvizDate(gvizGet(row, invMasterData.colMap, '盤點日期')),
      items:     [],
    };
  });
  invDetailData.rows.forEach(row => {
    const sid = String(gvizGet(row, invDetailData.colMap, '盤點編號') || '').trim();
    const master = mySessions[sid];
    if (!master) return;
    master.items.push({
      productId:   String(gvizGet(row, invDetailData.colMap, '產品ID') || ''),
      productName: String(gvizGet(row, invDetailData.colMap, '產品名稱') || ''),
      qty:         gvizGet(row, invDetailData.colMap, '產品數量'),
      note:        String(gvizGet(row, invDetailData.colMap, '盤點備註') || ''),
      expiry:      String(gvizGet(row, invDetailData.colMap, '產品效期') || ''),
    });
  });
  const inventory = Object.values(mySessions).sort((a, b) => (b.date > a.date ? 1 : (b.date < a.date ? -1 : 0)));

  return json({ ok: true, pharmacy, orders, returns, inventory });
}

// ============================================================
// 22. LINE 速記解析（業務員在 LINE 上用極簡速記打的拜訪/訂單筆記，
//     比對真實產品/藥局清單解析成結構化草稿；純回傳顯示，不寫入任何資料表）
// ============================================================
async function handleParseLineNotes(request, env) {
  const tStart = Date.now();
  const { text } = await request.json();
  if (!text || !text.trim()) return json({ error: '缺少文字內容' }, 400);

  const [productData, pharmacyData] = await Promise.all([
    fetchGvizSheet(env.SHEET_PRODUCT, null, env),
    fetchGvizSheet(env.SHEET_PHARMACY, '新客戶資料表_AppSheet', env),
  ]);
  console.log(`[parse-line-notes] sheets fetched, elapsed=${Date.now() - tStart}ms`);

  const products = productData.rows
    .map(row => ({
      id:       String(gvizGet(row, productData.colMap, '產品編號2') || '').trim(),
      name:     String(gvizGet(row, productData.colMap, '產品名稱') || '').trim(),
      category: String(gvizGet(row, productData.colMap, '小分類名稱') || '').trim(),
    }))
    .filter(p => p.id && p.name);

  const pharmacies = pharmacyData.rows
    .map(row => ({
      id:   String(gvizGet(row, pharmacyData.colMap, 'Customer_ID') || '').trim(),
      name: String(gvizGet(row, pharmacyData.colMap, '店名') || '').trim(),
    }))
    .filter(p => p.id && p.name);

  const now = new Date();
  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

  const prompt = `你是藥局業務助理，幫忙把業務員在 LINE 上用極簡速記打的拜訪/訂單筆記，解析成結構化資料。

【真實產品清單】（id|名稱|分類，只能比對到這個清單裡的產品，比對不到就老實標記找不到，不要亂猜一個相近的名字）：
${products.map(p => `${p.id}|${p.name}|${p.category}`).join('\n')}

【真實藥局清單】（id|店名，只能比對到這個清單裡的店，比對不到就老實標記找不到）：
${pharmacies.map(p => `${p.id}|${p.name}`).join('\n')}

【已知的錯字/暱稱對照】（業務員常用語音輸入打字，同一個產品每次打錯的方式都不一樣，以下是過去驗證過的對應，供參考不是全部，共用同一個字不代表是同一個產品，例如「肝尖」是甘堅胃腸藥、「肝藥」卻是朝鮮薊，不要只看字面相似度）：
舒伯特→葡萄糖-舒伯特葡萄糖；隻麻酥/芝麻素→芝麻素-新樂康芝麻素；愛寧書/愛寧叔→新愛寧舒錠；補精→美佳養生濃縮補精；鈣/蓋→新勇力優鈣；退熱貼→新泰康退熱貼；血紅素→金速美血紅素；諾力鈣/葡萄糖安/葡萄糖胺→諾立維他鈣；多多b→多多維力錠；B50/b50→富美樂B錠；膠原蛋白粉→泰康膠原蛋白胜肽粉；義課粽/異客總→益克綜膠囊食品；草先機/樂保養/肝藥→朝鮮薊-樂寶益；見了清→健樂清；肝尖/肝尖中→新甘樫胃腸藥

【原始文字】（格式通常是「日期標題」+「HH:MM 姓名 內容」逐行，今天是 ${todayStr}）：
${text}

請依照以下規則解析：
1. 同一天內、時間間隔在15分鐘以內的連續訊息，判斷為同一次拜訪（同一家店），除非中間出現新的明確店名。時間間隔超過1小時，視為換了一家店（即使沒有重新打店名）。
2. 每次拜訪要盡量判斷是哪家店（用藥局清單比對），比對不到就 store 填 null、storeConfidence 填 "none"，不要亂猜一個相近的店名。
3. 每一行裡「產品+數字黏在一起」代表品項+數量（例如「葉黃素3」= 葉黃素 數量3），沒有數字就預設數量1，「各二」「兩盒」這類中文數量詞也要換成數字。
4. 排班提醒（日期、時段文字）、人名+評語、純店名列表、「圖片」這類不是訂單內容的行，整行原文放進 skippedLines，不要當作品項硬塞進某次拜訪。
5. 查不到對應產品的詞，仍要放進該次拜訪的 items 裡（保留原始文字），但 matchedProductId/matchedProductName 填 null、confidence 填 "none"，不要自己掰一個相近產品名稱。
6. 只輸出 JSON，不要 markdown 包裹、不要任何說明文字。

輸出格式（嚴格遵守，不要多加欄位）：
{"visits":[{"date":"YYYY-MM-DD","timeRange":"16:10-16:10","store":{"id":"C071","name":"康喜藥局"},"storeConfidence":"high|medium|low|none","items":[{"raw":"原始文字","matchedProductId":"1A","matchedProductName":"正式名稱","qty":3,"confidence":"high|medium|low|none"}],"note":""}],"skippedLines":["原始文字"]}
（store 查無對應時填 null；matchedProductId/matchedProductName 查無對應時都填 null）`;

  // 改走 OpenRouter（2026-10-24）：直接打 Gemini API 在 Cloudflare Workers 上會遇到
  // 「User location is not supported」地區限制（Cloudflare 出口IP不固定，剛好分配到
  // Google 不支援的地區就會被拒絕，跟帳號/金鑰/模型都無關），照抄 visit-worker 已經驗證
  // 穩定的備援模型清單 + JSON 驗證重試邏輯，不是只要「有回應」就算數
  // 2026-10-24 用 OpenRouter 的 /api/v1/models 即時查過，這批是當下真的還在架上的免費模型
  // （visit-worker 2026-10-07 那份清單短短不到一個月又有一半掛掉/被限流，免費模型汰換很快，
  //   之後若又大量失敗，用同樣方式重新查 https://openrouter.ai/api/v1/models 重排清單即可）
  const models = [
    'nvidia/nemotron-3.5-super-vl:free',
    'nvidia/nemotron-3.5-lightning:free',
    'nvidia/nemotron-3-ultra-550b-a55b:free',
    'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
    'xingchen-agi/xing4.0-29b-a4b:free',
    'google/gemma-4-31b-it:free',
    'google/gemma-4-26b-a4b-it:free',
    'cohere/north-mini-code:free',
  ];

  function extractJson(content) {
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      JSON.parse(match[0]);
      return match[0];
    } catch (e) {
      return null;
    }
  }

  let parsed = null;
  let lastError = '';

  console.log(`[parse-line-notes] promptLen=${prompt.length} elapsedSoFar=${Date.now() - tStart}ms`);
  const OVERALL_DEADLINE_MS = 25000;
  for (const model of models) {
    // 整條備援清單合計最多 25 秒，不管試到第幾個模型，時間到就直接放棄，不要讓單一個卡住的模型
    // 拖垮整個請求（曾經實測過：單一模型就算設了 10 秒逾時，在某些情況下還是可能不觸發）
    if (Date.now() - tStart > OVERALL_DEADLINE_MS) {
      console.log(`[parse-line-notes] overall deadline (${OVERALL_DEADLINE_MS}ms) reached, stop trying more models`);
      lastError = lastError || '整體逾時';
      break;
    }
    const t0 = Date.now();
    // 單一模型最多等 10 秒，卡住/掛著不回應就直接換下一個，不要讓整條備援清單被一個模型拖垮
    // 雙重保險：AbortController 中斷連線 + Promise.race 強制逾時，避免只靠 AbortSignal 在某些情況下沒確實生效
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('逾時（超過10秒未回應）')), 10000);
    });
    try {
      const res = await Promise.race([
        fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${env.OPENROUTER_KEY}`,
            'HTTP-Referer': 'https://bh06211301.github.io',
            'X-Title': 'Pharmacy Smart Board',
          },
          body: JSON.stringify({
            model,
            messages: [{ role: 'user', content: prompt }],
            max_tokens: 8000,
            temperature: 0.2,
          }),
          signal: controller.signal,
        }),
        timeoutPromise,
      ]);
      clearTimeout(timeoutId);
      const elapsed = Date.now() - t0;
      const data = await res.json();
      const content = data.choices?.[0]?.message?.content;
      console.log(`[parse-line-notes] model=${model} status=${res.status} elapsed=${elapsed}ms contentLen=${content?.length || 0} errMsg=${data.error?.message || ''}`);
      if (!content || !content.trim()) {
        lastError = data.error?.message || 'empty content';
        continue;
      }
      const jsonStr = extractJson(content);
      if (!jsonStr) {
        lastError = '回應不是有效 JSON';
        console.log(`[parse-line-notes] contentPreview=${content.slice(0, 200)}`);
        continue;
      }
      parsed = JSON.parse(jsonStr);
      break;
    } catch (e) {
      clearTimeout(timeoutId);
      const elapsed = Date.now() - t0;
      const msg = e.name === 'AbortError' ? '逾時（超過10秒未回應）' : e.message;
      console.log(`[parse-line-notes] model=${model} EXCEPTION elapsed=${elapsed}ms msg=${msg}`);
      lastError = msg;
      continue;
    }
  }

  if (!parsed) return json({ error: `AI 解析失敗（已試過全部備援模型）：${lastError}` }, 500);

  return json({ ok: true, visits: parsed.visits || [], skippedLines: parsed.skippedLines || [] });
}

// ============================================================
// SmartRoute 規劃流程 v2 第 1 階段：/api/plan、/api/rules、/api/followups
// docs/SPEC.md 第 4 節。參數都在 planner-config.js，這裡只有計算邏輯。
// 環境變數新增：SHEET_SCREENING（藥局每日異動追蹤）、SHEET_PLANNER（藥局規劃資料）
// ============================================================

async function fetchGvizRows(sheetId, sheetName) {
  const url = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:json&sheet=${encodeURIComponent(sheetName)}`;
  const res = await fetch(url);
  const text = await res.text();
  const jsonStr = text.replace(/^.*?({.*}).*$/s, '$1');
  const data = JSON.parse(jsonStr);
  const rows = data?.table?.rows || [];
  const cols = data?.table?.cols || [];
  const colMap = {};
  cols.forEach((c, i) => { colMap[c.label] = i; });
  return rows.map(row => {
    const get = (label) => row.c[colMap[label]]?.v ?? '';
    return { get };
  });
}

function daysBetween(fromDateStr, toDate) {
  if (!fromDateStr) return null;
  const from = new Date(String(fromDateStr).replace(/\//g, '-'));
  if (isNaN(from)) return null;
  return Math.floor((toDate - from) / 86400000);
}

function ratioTierOf(ratio) {
  if (ratio >= PLANNER_CONFIG.ratioColorThresholds.veryLate) return 'very-late';
  if (ratio >= PLANNER_CONFIG.ratioColorThresholds.late) return 'late';
  if (ratio >= PLANNER_CONFIG.ratioColorThresholds.soon) return 'soon';
  return 'early';
}

// ============================================================
// 客戶叫貨健康度分級（2026-10-27 改版）
// /api/plan（正式客戶排序）跟 /api/customer-tiers（客戶總覽頁分級）共用這一組函數，
// 確保兩邊看到的「這家是大咖/潛力新店/冷淡/一般」永遠一致。
// ============================================================
// 排除規則（2026-10-27 第二版，統一叫「不拜訪」）。符合任一條都不進任何統計分母，但要能在 A1 手動加成
// 「送貨」錨點（錨點 UI 還沒做，這裡只管排除分級/排序）：
//   - Z 欄「停用」有值：死客戶，無條件排除，不算進「不拜訪」這組。
//   - AA 欄「負責人」＝老爸：系統對老爸那邊的叫貨大多沒有紀錄（詳見 CLAUDE.md「死客戶／爸爸客戶 改欄位化」）。
//   - F 欄「縣市」在 PLANNER_CONFIG.excludedCities（新竹縣/新竹市）：C130 艾美藥局縣市欄本來就是新竹縣，
//     這條規則已經會抓到它，不用另開例外清單。
//   - C 欄「狀態」＝不拜訪：手動標記（目前 C135、C047 已填），取代原本叫「其他通路」的名字。
function isEligibleForTiering_(p) {
  if (p.deadReason) return false;
  if (p.owner === '老爸') return false;
  if (PLANNER_CONFIG.excludedCities.indexOf(p.city) >= 0) return false;
  if (p.status === '不拜訪') return false;
  return true;
}

function monthsSinceJs(d1, d2) {
  let months = (d2.getFullYear() - d1.getFullYear()) * 12 + (d2.getMonth() - d1.getMonth());
  if (d2.getDate() < d1.getDate()) months -= 1;
  return Math.max(months, 0);
}

function percentile_(sorted, p) {
  if (!sorted.length) return null;
  const k = (sorted.length - 1) * p, f = Math.floor(k), c = Math.min(f + 1, sorted.length - 1);
  return f === c ? sorted[f] : sorted[f] + (sorted[c] - sorted[f]) * (k - f);
}

function quartiles_(sorted) {
  if (!sorted.length) return { min: null, q1: null, median: null, q3: null, max: null };
  return { min: sorted[0], q1: percentile_(sorted, 0.25), median: percentile_(sorted, 0.5), q3: percentile_(sorted, 0.75), max: sorted[sorted.length - 1] };
}

// 依客戶代號分組的叫貨統計。eligiblePharmacies 必須是已經過 isEligibleForTiering_ 篩過的名單，
// 訂單主檔裡不在名單上的 id（死客戶/老爸/新竹/不拜訪）直接跳過，不會污染任何分母。
// 2026-10-27 補：月均跟近3個月都改用「叫貨－退貨」淨額，不再只看叫貨——寄賣店 7 個月整理退貨時，
// 賣不掉的會退回、賣掉的會轉進貨再下一張單，兩筆都算叫貨會把同一批貨算兩次（自強藥局 C113 實測驗證過，
// 詳見 SPEC 4.5）。退貨單（returnOrderRows）的「店名」欄位直接存 Customer_ID，不用再 join 到明細。
function buildOrderStatsById_(orderRows, orderColMap, returnOrderRows, returnOrderColMap, eligiblePharmacies, today) {
  const nameById = {};
  eligiblePharmacies.forEach(p => { nameById[p.id] = p.name; });

  const ordersById = {};
  orderRows.forEach(row => {
    const id = String(row.c[orderColMap['店名']]?.v || '').trim();
    if (!id || !nameById[id]) return;
    const d = parseGvizDate(row.c[orderColMap['訂單日期']]?.v || '');
    if (!d) return;
    const date = new Date(String(d).replace(/\//g, '-'));
    if (isNaN(date)) return;
    const amount = parseFloat(row.c[orderColMap['總金額']]?.v || 0) || 0;
    (ordersById[id] = ordersById[id] || []).push({ date, amount });
  });

  const returnsById = {};
  returnOrderRows.forEach(row => {
    const id = String(row.c[returnOrderColMap['店名']]?.v || '').trim();
    if (!id || !nameById[id]) return;
    const d = parseGvizDate(row.c[returnOrderColMap['退貨日期']]?.v || '');
    if (!d) return;
    const date = new Date(String(d).replace(/\//g, '-'));
    if (isNaN(date)) return;
    const amount = parseFloat(row.c[returnOrderColMap['退貨金額']]?.v || 0) || 0;
    (returnsById[id] = returnsById[id] || []).push({ date, amount });
  });

  const yearAgo = new Date(today); yearAgo.setFullYear(yearAgo.getFullYear() - 1);
  const threeMoAgo = new Date(today); threeMoAgo.setMonth(threeMoAgo.getMonth() - 3);

  const statsById = {};
  eligiblePharmacies.forEach(p => {
    const orders = ordersById[p.id] || [];
    if (!orders.length) {
      statsById[p.id] = { id: p.id, name: p.name, hasOrders: false };
      return;
    }
    const returns = returnsById[p.id] || [];

    const dates = orders.map(o => o.date);
    const firstDate = new Date(Math.min(...dates));
    const lastDate = new Date(Math.max(...dates));

    const monthSet12mo = new Set();
    orders.forEach(o => { if (o.date >= yearAgo && o.date <= today) monthSet12mo.add(o.date.getFullYear() + '-' + o.date.getMonth()); });

    // 叫貨次數＝不同叫貨日期的數量（不是月份數，用來判斷「有沒有回購」）——只看叫貨，退貨不影響這個次數
    const orderCount = new Set(orders.map(o => o.date.toISOString().slice(0, 10))).size;

    const coopMonths = Math.max(monthsSinceJs(firstDate, today), 1);
    const totalOrderAmount = orders.reduce((s, o) => s + o.amount, 0);
    const totalReturnAmount = returns.reduce((s, o) => s + o.amount, 0);
    const netAmount = totalOrderAmount - totalReturnAmount;
    const avgMonthly = netAmount / coopMonths;

    const amount3moOrders = orders.filter(o => o.date >= threeMoAgo && o.date <= today).reduce((s, o) => s + o.amount, 0);
    const amount3moReturns = returns.filter(o => o.date >= threeMoAgo && o.date <= today).reduce((s, o) => s + o.amount, 0);
    const amount3mo = amount3moOrders - amount3moReturns; // 淨額，退貨比新單多時可以是負數
    const recent3MonthlyRate = amount3mo / 3;
    const momentumRatio = avgMonthly > 0 ? recent3MonthlyRate / avgMonthly : 0;

    statsById[p.id] = {
      id: p.id, name: p.name, hasOrders: true,
      firstDate: firstDate.toISOString().slice(0, 10), coopMonths,
      lastOrderDate: lastDate.toISOString().slice(0, 10),
      orderMonths12mo: monthSet12mo.size, orderCount,
      totalOrderAmount, totalReturnAmount, netAmount, avgMonthly, amount3mo, recent3MonthlyRate, momentumRatio,
      daysSinceLastOrder: Math.floor((today - lastDate) / 86400000),
      monthsSinceLastOrder: monthsSinceJs(lastDate, today),
    };
  });
  return statsById;
}

function avgMonthlyPercentile_(statsById, p) {
  const list = Object.values(statsById).filter(s => s.hasOrders).map(s => s.avgMonthly).sort((a, b) => a - b);
  return percentile_(list, p);
}

// 動量提醒（叫貨下滑／叫貨回溫），跟分級正交——大咖/潛力新店/一般都可能觸發，冷淡不標下滑
// （冷淡本身已經代表近3個月必定是0，標下滑沒有新資訊；回溫門檻>200%在冷淡狀態下數學上也不可能達成）。
function detectMomentumAlert_(stat, tier, medianAvgMonthly) {
  const A = PLANNER_CONFIG.alertThresholds;
  if (tier !== '冷淡' && stat.avgMonthly >= medianAvgMonthly && stat.momentumRatio < A.decliningMomentumBelow) {
    return '叫貨下滑';
  }
  if (stat.momentumRatio > A.reboundMomentumAbove) {
    return '叫貨回溫';
  }
  return null;
}

// 分級＋提醒合一（2026-10-27 第二版）：大咖 ▸ 首批後沒回購 ▸ 潛力新店 ▸ 冷淡 ▸ 一般，依序檢查，符合就停。
// 「首批後沒回購」判斷是分級序列的一部分（命中就強制歸一般，不會被判成潛力新店），
// 跟「叫貨下滑／叫貨回溫」這組動量提醒是分開邏輯，兩者不會同時出現在同一家店上。
// 門檻與間隔集中在 PLANNER_CONFIG.tierThresholds / tierIntervalDays / alertThresholds。
function classifyTierAndAlert_(stat, p70AvgMonthly, medianAvgMonthly) {
  const T = PLANNER_CONFIG.tierThresholds;
  const A = PLANNER_CONFIG.alertThresholds;
  if (!stat.hasOrders) return { tier: '一般', intervalDays: PLANNER_CONFIG.tierIntervalDays.一般, alert: null };

  if (stat.orderMonths12mo >= T.bigAccountMinMonths) {
    const tier = '大咖';
    return { tier, intervalDays: PLANNER_CONFIG.tierIntervalDays[tier], alert: detectMomentumAlert_(stat, tier, medianAvgMonthly) };
  }
  if (stat.coopMonths <= T.potentialMaxCoopMonths && stat.orderCount === 1 && stat.daysSinceLastOrder > A.noRepeatMinDaysSince) {
    return { tier: '一般', intervalDays: PLANNER_CONFIG.tierIntervalDays.一般, alert: '首批後沒回購' };
  }
  if (stat.coopMonths <= T.potentialMaxCoopMonths && stat.avgMonthly >= p70AvgMonthly) {
    const tier = '潛力新店';
    return { tier, intervalDays: PLANNER_CONFIG.tierIntervalDays[tier], alert: detectMomentumAlert_(stat, tier, medianAvgMonthly) };
  }
  if (stat.monthsSinceLastOrder > T.coldMinMonthsSinceOrder) {
    return { tier: '冷淡', intervalDays: PLANNER_CONFIG.tierIntervalDays.冷淡, alert: null };
  }
  const tier = '一般';
  return { tier, intervalDays: PLANNER_CONFIG.tierIntervalDays[tier], alert: detectMomentumAlert_(stat, tier, medianAvgMonthly) };
}

// 兩個日期字串取比較晚的那個（其中一個缺就回另一個；都缺回 null）——用來算「最後接觸日」＝拜訪或叫貨取比較近的
function laterDateOrNull_(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return (new Date(String(a).replace(/\//g, '-')) >= new Date(String(b).replace(/\//g, '-'))) ? a : b;
}

async function handleCustomerTiers(env) {
  const today = new Date();
  const [pharmaciesRes, orderData, returnOrderData] = await Promise.all([
    handleGetPharmacies(null, env).then(r => r.json()),
    fetchOrderMasterRows(env),
    fetchGvizSheet(env.SHEET_RETURN_ORDER, null, env),
  ]);

  const allPharmacies = pharmaciesRes.pharmacies || [];
  const eligible = allPharmacies.filter(isEligibleForTiering_);
  const statsById = buildOrderStatsById_(orderData.rows, orderData.colMap, returnOrderData.rows, returnOrderData.colMap, eligible, today);

  const p70AvgMonthly = avgMonthlyPercentile_(statsById, 0.70);
  const medianAvgMonthly = avgMonthlyPercentile_(statsById, 0.50);

  const tiers = { 潛力新店: [], 大咖: [], 冷淡: [], 一般: [] };
  const neverOrdered = [];
  const noRepeatOrder = [];
  const declining = [];
  const rebounding = [];

  eligible.forEach(p => {
    const stat = statsById[p.id];
    if (!stat.hasOrders) { neverOrdered.push({ id: p.id, name: p.name }); return; }
    const { tier, alert } = classifyTierAndAlert_(stat, p70AvgMonthly, medianAvgMonthly);
    stat.tier = tier;
    stat.rankScore = stat.momentumRatio * stat.avgMonthly;
    tiers[tier].push(stat);

    if (alert === '首批後沒回購') noRepeatOrder.push(stat);
    else if (alert === '叫貨下滑') declining.push(stat);
    else if (alert === '叫貨回溫') rebounding.push(stat);
  });

  const allStatsWithOrders = Object.values(statsById).filter(s => s.hasOrders);
  const top15 = allStatsWithOrders.slice().sort((a, b) => b.rankScore - a.rankScore).slice(0, 15);

  return json({
    ok: true,
    note: '只讀分析；跟 /api/plan 共用 classifyTierAndAlert_，分級定義保證兩邊一致',
    excludedCount: {
      total: allPharmacies.length, afterExclude: eligible.length,
      dead: allPharmacies.filter(p => p.deadReason).length,
      dad: allPharmacies.filter(p => p.owner === '老爸').length,
      hsinchu: allPharmacies.filter(p => PLANNER_CONFIG.excludedCities.indexOf(p.city) >= 0).length,
      noVisit: allPharmacies.filter(p => p.status === '不拜訪').length,
    },
    neverOrderedCount: neverOrdered.length,
    neverOrdered,
    tierCounts: Object.fromEntries(Object.entries(tiers).map(([k, v]) => [k, v.length])),
    tiers,
    avgMonthlyQuartiles: quartiles_(allStatsWithOrders.map(s => s.avgMonthly).sort((a, b) => a - b)),
    p70AvgMonthly, medianAvgMonthly,
    orderMonthsQuartiles: quartiles_(allStatsWithOrders.map(s => s.orderMonths12mo).sort((a, b) => a - b)),
    top15,
    noRepeatOrder, declining, rebounding,
  });
}

// 星期：同時接受「、」和「,」分隔（Sheets 多選存成逗號格式，手動輸入常用頓號）
const WEEKDAY_NAMES = ['日', '一', '二', '三', '四', '五', '六']; // 對應 JS Date.getDay() 0~6
function matchesWeekday(weekdaysStr, planDate) {
  if (!weekdaysStr) return false;
  const todayName = WEEKDAY_NAMES[planDate.getDay()];
  return weekdaysStr.split(/[、,]/).map(s => s.trim()).includes(todayName);
}

// 每月日期：格式「起-迄」（含「5-5」這種單日），檢查規劃日的「日」是否落在範圍內
function matchesMonthDay(monthDaysStr, planDate) {
  if (!monthDaysStr) return false;
  const m = String(monthDaysStr).match(/^(\d+)\s*-\s*(\d+)$/);
  if (!m) return false;
  const day = planDate.getDate();
  return day >= parseInt(m[1], 10) && day <= parseInt(m[2], 10);
}

// 2026-10-25 補：/api/plan 每家店附上 ruleStatus（可以去／擋住／提醒＋規則說明），A1/A8 第 2 階段要用。
// 日期無關的規則（星期、每月日期都空白，例如「拜訪前先做」「其他提醒」類）一律視為永遠適用。
// 衝突對話框（A4）、自動調整時段仍排在第 3 階段，這裡只做標示，不會真的改排序。
function evalRuleStatus(ruleRows, storeId, planDate) {
  const matched = ruleRows.filter(r => {
    if (r.get('店家代號') !== storeId) return false;
    if ((r.get('狀態') || '有效') !== '有效') return false;
    const weekdays = r.get('星期');
    const monthDays = r.get('每月日期');
    if (!weekdays && !monthDays) return true; // 沒有日期限制的規則，永遠適用
    return matchesWeekday(weekdays, planDate) || matchesMonthDay(monthDays, planDate);
  });
  if (!matched.length) return { status: '可以去', rules: [] };

  const block = matched.find(r => r.get('排程處理') === '擋住');
  if (block) return { status: '擋住', rules: matched.map(r => r.get('說明')).filter(Boolean) };

  const adjust = matched.find(r => r.get('排程處理') === '自動調整');
  if (adjust) return { status: '自動調整', rules: matched.map(r => r.get('說明')).filter(Boolean) };

  return { status: '提醒', rules: matched.map(r => r.get('說明')).filter(Boolean) };
}

// 待追蹤分：該店全部未完成待追蹤加總，上限 followupScoreCap；同時回傳給 reason 用的摘要文字
function scoreFollowups(followupRows, storeId, planDate) {
  let score = 0;
  const items = [];
  followupRows.forEach(f => {
    if (f.get('店家代號') !== storeId) return;
    if ((f.get('狀態') || '未完成') !== '未完成') return;
    const deadlineType = f.get('期限類型') || '下次經過';
    const item = f.get('事項') || '';
    let points = 0;
    if (deadlineType === '下次經過') {
      points = PLANNER_CONFIG.followupScore.nextVisit;
    } else {
      // daysBetween(a,b) 算的是 b-a（天數），這裡要「期限 - 規劃日」還剩幾天
      const deadline = f.get('期限');
      const daysUntil = deadline ? -daysBetween(deadline, planDate) : null;
      if (daysUntil === null) points = PLANNER_CONFIG.followupScore.dueLater;
      else if (daysUntil <= 3) points = PLANNER_CONFIG.followupScore.dueWithin3Days;
      else if (daysUntil <= 7) points = PLANNER_CONFIG.followupScore.dueWithin7Days;
      else points = PLANNER_CONFIG.followupScore.dueLater;
    }
    score += points;
    if (item) items.push(item);
  });
  return { score: Math.min(score, PLANNER_CONFIG.followupScoreCap), items };
}

async function handlePlannerPlan(request, env) {
  const url = new URL(request.url);
  const dateParam = url.searchParams.get('date');
  const planDate = dateParam ? new Date(dateParam) : new Date();
  if (isNaN(planDate)) return json({ error: 'date 格式不對，要 YYYY-MM-DD' }, 400);

  const [pharmaciesRes, visitsRes, screeningRows, followupRows, ruleRows, orderData, returnOrderData, contractData] = await Promise.all([
    handleGetPharmacies(null, env).then(r => r.json()),
    handleVisitsSummary(env).then(r => r.json()),
    env.SCREENING_API_TOKEN
      ? fetch(`${SCREENING_API_URL}?token=${encodeURIComponent(env.SCREENING_API_TOKEN)}`).then(r => r.json()).then(d => d.rows || [])
      : Promise.resolve([]),
    env.SHEET_PLANNER ? fetchGvizRows(env.SHEET_PLANNER, '待追蹤') : Promise.resolve([]),
    env.SHEET_PLANNER ? fetchGvizRows(env.SHEET_PLANNER, '店家規則') : Promise.resolve([]),
    env.SHEET_ORDER_MASTER ? fetchOrderMasterRows(env) : Promise.resolve({ rows: [], colMap: {} }),
    fetchGvizSheet(env.SHEET_RETURN_ORDER, null, env),
    // 「客戶合約」目前沒開「知道連結的人可檢視」，gviz 會拿到 Google 登入頁而不是 JSON，
    // 用 try/catch 吞掉，當作沒有合約資料（全部店都走沒合約的 7 個月規則），不要讓整個 /api/plan 掛掉
    env.SHEET_CONTRACT
      ? fetchGvizSheet(env.SHEET_CONTRACT, '客戶合約', env).catch(() => ({ rows: [], colMap: {}, fetchError: true }))
      : Promise.resolve({ rows: [], colMap: {} }),
  ]);

  const allPharmacies = pharmaciesRes.pharmacies || [];
  const visitMap = visitsRes.summary || {};

  // 2026-10-27 改版：排除死客戶／老爸／新竹縣市／狀態=不拜訪（isEligibleForTiering_，跟 /api/customer-tiers 共用），
  // 只對剩下的「我」負責正式客戶做分級與倍數排序。分級邏輯跟 /api/customer-tiers 共用 classifyTierAndAlert_。
  const eligible = allPharmacies.filter(isEligibleForTiering_);
  const statsById = buildOrderStatsById_(orderData.rows, orderData.colMap, returnOrderData.rows, returnOrderData.colMap, eligible, planDate);
  const p70AvgMonthly = avgMonthlyPercentile_(statsById, 0.70);
  const medianAvgMonthly = avgMonthlyPercentile_(statsById, 0.50);

  const list = [];
  const anchors = [];
  const eligibleIds = new Set(eligible.map(p => p.id));

  // 第四種提醒「寄賣整理」：只掃排除規則篩過的名單（死客戶/老爸/新竹/不拜訪不檢查，2026-10-27 修正，
  // 之前版本掃全部客戶，誤把死客戶 C015/C038 列進來）。先彙整每家店目前「寄賣中(資料夾)」的全部訂單
  // （allTotal 不管多久，staleXxx 只算 >= consignmentCleanupMonths 個月的），下面依有沒有合約分兩種處理。
  const consignmentByStore = {};
  orderData.rows.forEach(row => {
    const status = String(row.c[orderData.colMap['紅單實體狀態']]?.v || '').trim();
    if (status !== '寄賣中(資料夾)') return;
    const id = String(row.c[orderData.colMap['店名']]?.v || '').trim();
    if (!id || !eligibleIds.has(id)) return;
    const d = parseGvizDate(row.c[orderData.colMap['訂單日期']]?.v || '');
    if (!d) return;
    const orderDate = new Date(String(d).replace(/\//g, '-'));
    if (isNaN(orderDate)) return;
    const amount = parseFloat(row.c[orderData.colMap['總金額']]?.v || 0) || 0;
    const monthsSince = monthsSinceJs(orderDate, planDate);
    const entry = (consignmentByStore[id] = consignmentByStore[id] || { allTotal: 0, staleCount: 0, staleMaxMonths: 0, staleTotal: 0 });
    entry.allTotal += amount;
    if (monthsSince >= PLANNER_CONFIG.consignmentCleanupMonths) {
      entry.staleCount += 1;
      entry.staleTotal += amount;
      entry.staleMaxMonths = Math.max(entry.staleMaxMonths, monthsSince);
    }
  });

  // Phase 2：業務親送的錨點（SPEC 5.2）——訂單主檔「貨運公司」＝業務親送、且「訂單日期」＝規劃日的單，
  // 自動變成 A1 第①欄的錨點（來源「送貨」），不管店家是不是排除規則篩過的名單內（老爸/新竹的送貨單也要列出來）。
  const planDateStr = `${planDate.getFullYear()}/${planDate.getMonth() + 1}/${planDate.getDate()}`;
  const pharmacyNameById_ = {};
  allPharmacies.forEach(p => { pharmacyNameById_[p.id] = p.name; });
  orderData.rows.forEach(row => {
    const carrier = String(row.c[orderData.colMap['貨運公司']]?.v || '').trim();
    if (carrier !== '業務親送') return;
    const orderDateStr = parseGvizDate(row.c[orderData.colMap['訂單日期']]?.v || '');
    if (orderDateStr !== planDateStr) return;
    const id = String(row.c[orderData.colMap['店名']]?.v || '').trim();
    if (!id) return;
    anchors.push({ id, name: pharmacyNameById_[id] || id, source: '送貨', item: '業務親送訂單', deadline: null });
  });

  // 「客戶合約」：合約狀態＝終止 不算簽約店，空白視為有效。讀不到（分享權限/試算表問題）就當作沒有合約資料。
  const contractByStore = {};
  contractData.rows.forEach(row => {
    const id = String(row.c[contractData.colMap['Customer_ID']]?.v || '').trim();
    if (!id) return;
    const status = String(row.c[contractData.colMap['合約狀態']]?.v || '').trim();
    if (status === '終止') return;
    const amount = parseFloat(row.c[contractData.colMap['切口金額']]?.v || 0) || 0;
    contractByStore[id] = amount;
  });

  // 待追蹤拆成「已到期」跟「還沒到期」兩組：已到期的整筆變成 anchors（來源標「待追蹤」），不參加排名；
  // 還沒到期的（含「下次經過」這種沒有具體日期的）留在原地，乘上 followupMultiplier 影響排序分。
  // 期限類型＝下次經過：沒有具體日期可比，一律視為「還沒到期」。
  function splitFollowups_(storeId) {
    const due = [], notDue = [];
    followupRows.forEach(f => {
      if (f.get('店家代號') !== storeId) return;
      if ((f.get('狀態') || '未完成') !== '未完成') return;
      const deadlineType = f.get('期限類型') || '下次經過';
      const item = f.get('事項') || '';
      if (deadlineType === '指定日期前') {
        const deadline = f.get('期限');
        const daysUntil = deadline ? -daysBetween(deadline, planDate) : null;
        if (daysUntil !== null && daysUntil <= 0) { due.push({ item, deadline }); return; }
      }
      notDue.push({ item });
    });
    return { due, notDue };
  }

  // 正式客戶：倍數改用「最後接觸日」＝拜訪日跟叫貨日取比較近的那個（2026-10-27 第二版，拿掉上一版
  // 「只看拜訪日、從未拜訪排最前」的做法）。兩者都沒有時倍數固定 1.0（不特別拉最前也不墊底）。
  // 間隔依分級（大咖/潛力新店/冷淡/一般）決定，見 PLANNER_CONFIG.tierIntervalDays。
  eligible.forEach(p => {
    const stat = statsById[p.id];
    const { tier, intervalDays, alert } = classifyTierAndAlert_(stat, p70AvgMonthly, medianAvgMonthly);
    const avgMonthly = stat.hasOrders ? stat.avgMonthly : 0;
    const ruleStatus = evalRuleStatus(ruleRows, p.id, planDate);
    const visitDate = (visitMap[p.id] || {}).lastDate || '';
    const orderDate = stat.hasOrders ? stat.lastOrderDate : '';
    const lastContactDate = laterDateOrNull_(visitDate, orderDate);

    const { due, notDue } = splitFollowups_(p.id);
    due.forEach(f => anchors.push({ id: p.id, name: p.name, source: '待追蹤', item: f.item, deadline: f.deadline || null }));
    const followupMultiplier = notDue.length ? PLANNER_CONFIG.followupMultiplier : 1;
    const notDueItems = notDue.map(f => f.item).filter(Boolean);

    let daysSince, rawRatio;
    if (!lastContactDate) {
      daysSince = null;
      rawRatio = 1.0; // 從未拜訪也從未叫貨：倍數固定 1.0
    } else {
      daysSince = daysBetween(lastContactDate, planDate);
      rawRatio = daysSince / intervalDays;
    }
    // 2026-10-27 補：冷淡的店倍數封頂（PLANNER_CONFIG.tierRatioCap），避免很久沒接觸的店單靠天數就衝到排序前段；
    // 其他級別不設上限。封頂只影響排序分，reason 裡仍會顯示原始倍數讓你知道實際差多久。
    const ratioCapForTier = PLANNER_CONFIG.tierRatioCap[tier];
    const ratio = ratioCapForTier ? Math.min(rawRatio, ratioCapForTier) : rawRatio;
    const ratioCapped = ratio !== rawRatio;

    // 第四種提醒「寄賣整理」：有合約看金額（寄賣中總額 >= 切口金額×倍率），沒合約看天數（維持7個月規則）。
    // 不寫 anchors，直接影響這家店自己的排序分跟推薦理由。
    const contractAmount = contractByStore[p.id];
    const isContracted = contractAmount !== undefined;
    const consignment = consignmentByStore[p.id] || null;
    // 寄賣/對帳的狀態文字交給前端用 isContracted/contractAmount/consignmentAllTotal/
    // consignmentStaleCount 這幾個欄位自己組徽章（跟 reason 分開顯示，不要重複），這裡只需要算出倍率。
    let consignmentMultiplier = 1;
    if (!isContracted && consignment && consignment.staleCount > 0) {
      consignmentMultiplier = PLANNER_CONFIG.consignmentMultiplier;
    }

    const rankScoreBase = ratio * avgMonthly; // 倍數(已套冷淡封頂)×月均叫貨，不設上限
    const rankScore = rankScoreBase * followupMultiplier * consignmentMultiplier;
    const score = Math.round(rankScore);
    list.push({
      id: p.id, name: p.name, type: 'customer', stage: '正式客戶', tier, intervalDays,
      daysSince, ratio: Math.round(ratio * 100) / 100, rawRatio: Math.round(rawRatio * 100) / 100, ratioCapped, avgMonthly,
      score, rankScore: Math.round(rankScore), followupMultiplier, followupItems: notDueItems, ruleStatus, alert,
      isContracted, contractAmount: isContracted ? contractAmount : null,
      consignmentAllTotal: consignment ? Math.round(consignment.allTotal) : 0,
      consignmentStaleCount: consignment ? consignment.staleCount : 0,
      consignmentStaleMaxMonths: consignment ? consignment.staleMaxMonths : 0,
      consignmentStaleTotal: consignment ? Math.round(consignment.staleTotal) : 0,
      consignmentMultiplier,
      // 2026-10-28 改：只寫計算過程，不重複分級／提醒文字（畫面上已經用徽章顯示），
      // 寄賣的倍率（×1.5）保留，因為那是影響排序分的數字，不是單純狀態說明。
      reason: (daysSince === null
          ? `從未拜訪也從未叫貨，倍數固定 1.0`
          : `${daysSince} / ${intervalDays} 天 = ${(Math.round(rawRatio * 100) / 100)} 倍` +
            (ratioCapped ? `（封頂算 ${ratio}）` : '')) +
        `・月均 $${Math.round(avgMonthly).toLocaleString()}` +
        (followupMultiplier !== 1 ? `・待追蹤×${followupMultiplier}` : '') +
        (consignmentMultiplier !== 1 ? `・寄賣×${consignmentMultiplier}` : '') +
        (notDueItems.length ? `・${notDueItems.join('、')}` : ''),
    });
  });

  // 新店開發（篩選分頁，決定＝要去，階段不是轉正式／放棄）：維持原本的階段邏輯，完全不受上面改版影響——
  // 起算日＝進入階段日期，間隔依階段，倍數公式仍是舊版 min(倍數,ratioCap)*weight。
  // 2026-10-28 補：篩選分頁的「階段」欄位沒有自動連動──它追蹤的是「藥局每日異動追蹤」稅籍比對出來的
  // 開發線索（木木好用這條路徑的 id 是 ce73d892dd），跟 pharmacy-visit-app「新案開發」當場建檔走的是
  // 另一套暫存代號機制（木木好那次用的是 f3e4049d69→C137），兩套系統從來沒互相通知過彼此，所以同一家店
  // 有可能先被稅籍比對列成開發線索，後來又從另一條路徑直接建檔成正式客戶，篩選分頁那一列卻永遠停在
  // 建檔前的階段文字（不會變成「轉正式」）。這裡沒有欄位可以直接查「已轉正」，只能用店名比對：
  // 篩選分頁這一列的店名如果跟某個正式客戶完全相同，視為已經轉正，不再列進新店開發清單。
  const realCustomerNames_ = new Set(allPharmacies.map(p => String(p.name || '').trim()).filter(Boolean));
  screeningRows.forEach(r => {
    const { decision, stage, id, name } = r;
    if (decision !== '要去') return;
    if (!stage || stage === '轉正式' || stage === '放棄') return;
    if (realCustomerNames_.has(String(name || '').trim())) return;
    const interval = PLANNER_CONFIG.stageIntervalDays[stage];
    if (!interval) return; // 不認得的階段文字，跳過不猜
    const daysSince = daysBetween(r.stageDate, planDate);
    if (daysSince === null) return;
    const ratio = daysSince / interval;
    const intervalScore = Math.min(ratio, PLANNER_CONFIG.ratioCap) * PLANNER_CONFIG.intervalScoreWeight;
    const followup = scoreFollowups(followupRows, id, planDate);
    const score = Math.round(intervalScore + followup.score);
    const ruleStatus = evalRuleStatus(ruleRows, id, planDate);
    list.push({
      id, name, type: 'new-store', stage,
      daysSince, interval, ratio: Math.round(ratio * 100) / 100, ratioTier: ratioTierOf(ratio),
      score, followupItems: followup.items, ruleStatus,
      reason: `${daysSince} / ${interval} 天 = ${(Math.round(ratio * 100) / 100)} 倍` +
        (followup.items.length ? `・${followup.items.join('、')}` : ''),
    });
  });

  // 排序：倍數≥1（該去了）＞ 倍數<1（還沒到）；組內用 score（＝倍數×月均叫貨×待追蹤倍率）遞減排序，
  // 不設上限；同分再用月均決勝。
  function bucketOf(item) { return item.ratio >= 1 ? 1 : 0; }
  list.sort((a, b) => {
    const diff = bucketOf(b) - bucketOf(a);
    if (diff !== 0) return diff;
    return (b.score - a.score) || ((b.avgMonthly || 0) - (a.avgMonthly || 0));
  });

  // Phase 2：A1 第①③欄一旦存過檔（POST /api/plan），這裡直接蓋掉 anchors／補上 route，
  // 讓重新整理頁面時能恢復今天已經決定好的錨點清單與確定路線，不會每次都退回系統剛算出來的預設值。
  const dateKey = planDate.toISOString().slice(0, 10);
  let route = null;
  if (env.TODOS_KV) {
    const saved = await env.TODOS_KV.get(`plan:${dateKey}`, 'json');
    if (saved) {
      if (Array.isArray(saved.anchors)) anchors.length = 0, anchors.push(...saved.anchors);
      if (Array.isArray(saved.route)) route = saved.route;
    }
  }

  // Phase 2：主選單紅色數字徽章用的全站統計（跟目前看的規劃日無關，一律以「現在」為準）——
  // 客戶＝倍數≥1.0的家數（DESIGN.md 2.1），待追蹤＝3天內到期件數（含逾期，不含「下次經過」這種沒有
  // 具體日期的，因為算不出「幾天內」）。徽章數字為0時前端不顯示。
  const now_ = new Date();
  const badgeCustomers = list.filter(item => item.type === 'customer' && item.ratio >= 1).length;
  const badgeFollowupsDueSoon = followupRows.filter(f => {
    if ((f.get('狀態') || '未完成') !== '未完成') return false;
    if ((f.get('期限類型') || '下次經過') !== '指定日期前') return false;
    const deadline = f.get('期限');
    if (!deadline) return false;
    const daysUntil = -daysBetween(deadline, now_);
    return daysUntil <= 3;
  }).length;

  return json({
    ok: true,
    date: dateKey,
    recommended: list,
    anchors, route,
    badges: { customers: badgeCustomers, followupsDueSoon: badgeFollowupsDueSoon },
    p70AvgMonthly, medianAvgMonthly,
    note: '2026-10-27 第二版：倍數改用「最後接觸日」(拜訪或叫貨取較近)，兩者都沒有固定倍數1.0；分級決定間隔；倍數≥1用倍數×月均排序不設上限；到期待追蹤移入 anchors 不參加排名，未到期的乘上 followupMultiplier；還沒套用 2 公里錨點半徑篩選；老爸/新竹縣市/狀態=不拜訪 已排除在推薦外，要在 A1 手動加成送貨錨點（等 A1 錨點 UI 做出來再接）。Phase 2：anchors/route 若當天已存檔會蓋掉系統預設值，見 /api/plan POST',
  });
}

// Phase 2：儲存當天的錨點清單＋確定路線（A1「確定，送到手機外勤模式」或任何加入/移除錨點的動作都呼叫這支）
async function handleSavePlan(request, env) {
  const body = await request.json();
  const { date, anchors, route } = body;
  if (!date) return json({ error: '缺少 date' }, 400);
  if (!env.TODOS_KV) return json({ error: '未設定 TODOS_KV' }, 500);
  await env.TODOS_KV.put(`plan:${date}`, JSON.stringify({ anchors: anchors || [], route: route || null, savedAt: new Date().toISOString() }));
  return json({ ok: true });
}

// ============================================================
// Phase 2：A8 藥局檔案抽屜 — 單店全部資料
// 分級/寄賣/簽約那一段直接複用 /api/plan 的同一組函數跟同一套資料來源，保證兩邊看到的數字一致；
// 不是另外寫一套算法。代價是跟 /api/plan 一樣要整批撈訂單/退貨/合約資料，但這是給抽屜用的低頻端點，不是列表。
// ============================================================
async function handleStoreDetail(request, env) {
  const url = new URL(request.url);
  const id = url.searchParams.get('id');
  if (!id) return json({ error: '缺少 id' }, 400);
  const planDate = new Date();

  const [pharmaciesRes, visitsRes, screeningRows, followupRows, ruleRows, orderData, returnOrderData, contractData] = await Promise.all([
    handleGetPharmacies(null, env).then(r => r.json()),
    handleVisitsSummary(env).then(r => r.json()),
    env.SCREENING_API_TOKEN
      ? fetch(`${SCREENING_API_URL}?token=${encodeURIComponent(env.SCREENING_API_TOKEN)}`).then(r => r.json()).then(d => d.rows || [])
      : Promise.resolve([]),
    env.SHEET_PLANNER ? fetchGvizRows(env.SHEET_PLANNER, '待追蹤') : Promise.resolve([]),
    env.SHEET_PLANNER ? fetchGvizRows(env.SHEET_PLANNER, '店家規則') : Promise.resolve([]),
    env.SHEET_ORDER_MASTER ? fetchOrderMasterRows(env) : Promise.resolve({ rows: [], colMap: {} }),
    fetchGvizSheet(env.SHEET_RETURN_ORDER, null, env),
    env.SHEET_CONTRACT
      ? fetchGvizSheet(env.SHEET_CONTRACT, '客戶合約', env).catch(() => ({ rows: [], colMap: {}, fetchError: true }))
      : Promise.resolve({ rows: [], colMap: {} }),
  ]);

  const allPharmacies = pharmaciesRes.pharmacies || [];
  const pharmacy = allPharmacies.find(p => p.id === id);
  const screeningRow = screeningRows.find(r => r.id === id);
  if (!pharmacy && !screeningRow) return json({ error: `找不到店家：${id}` }, 404);

  const myRules = ruleRows
    .filter(r => r.get('店家代號') === id)
    .map(r => ({
      ruleId: r.get('規則ID'), ruleType: r.get('規則類型'), weekdays: r.get('星期'), monthDays: r.get('每月日期'),
      timeFrom: r.get('時段起'), timeTo: r.get('時段迄'), note: r.get('說明'), action: r.get('排程處理'),
      source: r.get('來源'), status: r.get('狀態') || '有效',
    }))
    .filter(r => r.status === '有效');

  const myFollowups = followupRows
    .filter(f => f.get('店家代號') === id)
    .map(f => ({
      followupId: f.get('待追蹤ID'), item: f.get('事項'), who: f.get('誰交代') || '我',
      deadlineType: f.get('期限類型') || '下次經過', deadline: f.get('期限') || null,
      status: f.get('狀態') || '未完成',
    }))
    .filter(f => f.status === '未完成');

  // 老爸/新竹/不拜訪/死客戶：不列入分級，前端看 tiering===null 顯示「不列入分級」說明，不要自己再跑一次判斷
  let tiering = null;
  if (pharmacy && isEligibleForTiering_(pharmacy)) {
    const eligible = allPharmacies.filter(isEligibleForTiering_);
    const statsById = buildOrderStatsById_(orderData.rows, orderData.colMap, returnOrderData.rows, returnOrderData.colMap, eligible, planDate);
    const p70AvgMonthly = avgMonthlyPercentile_(statsById, 0.70);
    const medianAvgMonthly = avgMonthlyPercentile_(statsById, 0.50);
    const stat = statsById[id];
    const { tier, intervalDays, alert } = classifyTierAndAlert_(stat, p70AvgMonthly, medianAvgMonthly);
    const avgMonthly = stat.hasOrders ? stat.avgMonthly : 0;
    const visitMap = visitsRes.summary || {};
    const visitDate = (visitMap[id] || {}).lastDate || '';
    const orderDate = stat.hasOrders ? stat.lastOrderDate : '';
    const lastContactDate = laterDateOrNull_(visitDate, orderDate);
    const daysSince = lastContactDate ? daysBetween(lastContactDate, planDate) : null;
    const rawRatio = daysSince === null ? 1.0 : daysSince / intervalDays;
    const ratioCapForTier = PLANNER_CONFIG.tierRatioCap[tier];
    const ratio = ratioCapForTier ? Math.min(rawRatio, ratioCapForTier) : rawRatio;

    let contractAmount, isContracted = false;
    contractData.rows.forEach(row => {
      const cid = String(row.c[contractData.colMap['Customer_ID']]?.v || '').trim();
      if (cid !== id) return;
      const status = String(row.c[contractData.colMap['合約狀態']]?.v || '').trim();
      if (status === '終止') return;
      isContracted = true;
      contractAmount = parseFloat(row.c[contractData.colMap['切口金額']]?.v || 0) || 0;
    });
    let consignment = { allTotal: 0, staleCount: 0, staleMaxMonths: 0, staleTotal: 0 };
    orderData.rows.forEach(row => {
      const status = String(row.c[orderData.colMap['紅單實體狀態']]?.v || '').trim();
      if (status !== '寄賣中(資料夾)') return;
      if (String(row.c[orderData.colMap['店名']]?.v || '').trim() !== id) return;
      const d = parseGvizDate(row.c[orderData.colMap['訂單日期']]?.v || '');
      if (!d) return;
      const orderDateObj = new Date(String(d).replace(/\//g, '-'));
      if (isNaN(orderDateObj)) return;
      const amount = parseFloat(row.c[orderData.colMap['總金額']]?.v || 0) || 0;
      const monthsSince = monthsSinceJs(orderDateObj, planDate);
      consignment.allTotal += amount;
      if (monthsSince >= PLANNER_CONFIG.consignmentCleanupMonths) {
        consignment.staleCount += 1;
        consignment.staleTotal += amount;
        consignment.staleMaxMonths = Math.max(consignment.staleMaxMonths, monthsSince);
      }
    });
    let consignmentText = '';
    if (isContracted) {
      if (consignment.allTotal >= contractAmount * PLANNER_CONFIG.consignmentReconcileMultiplier) {
        consignmentText = `該對帳：寄賣中 $${Math.round(consignment.allTotal).toLocaleString()} / 切口 $${Math.round(contractAmount).toLocaleString()}`;
      }
    } else if (consignment.staleCount > 0) {
      consignmentText = `寄賣${consignment.staleCount}張待整理，最久${consignment.staleMaxMonths}個月，共 $${Math.round(consignment.staleTotal).toLocaleString()}`;
    }

    tiering = {
      tier, intervalDays, alert, avgMonthly, daysSince,
      ratio: Math.round(ratio * 100) / 100, rawRatio: Math.round(rawRatio * 100) / 100,
      isContracted, contractAmount: isContracted ? contractAmount : null,
      consignmentAllTotal: Math.round(consignment.allTotal), consignmentStaleCount: consignment.staleCount,
      consignmentStaleMaxMonths: consignment.staleMaxMonths, consignmentStaleTotal: Math.round(consignment.staleTotal),
      consignmentText,
      ruleStatus: evalRuleStatus(ruleRows, id, planDate),
    };
  }

  const excludeReason = pharmacy && !tiering
    ? (pharmacy.deadReason ? '死客戶' : pharmacy.owner === '老爸' ? '老爸客戶' : PLANNER_CONFIG.excludedCities.indexOf(pharmacy.city) >= 0 ? '新竹地區' : pharmacy.status === '不拜訪' ? '標記不拜訪' : null)
    : null;

  // 2026-10-28：A8 進貨長條圖原本讀「出貨明細」(SHEET_ORDER，透過店名_備份比對，/pharmacy-profile 用的那份)，
  // 跟評分(/api/plan 的月均叫貨、這裡的 tiering)讀的「訂單主檔」(SHEET_ORDER_MASTER，透過店名欄位比對)是
  // 兩張完全不同的表——出貨明細是逐品項的出貨紀錄，訂單主檔是整張訂單的金額+寄賣狀態追蹤，兩邊店家名單、
  // 日期完整度都不保證一致（C133 永佳健保藥局 2026/6/18 那筆 $32,270，評分讀得到，出貨明細那邊卻讀不到）。
  // 長條圖改成直接用這裡已經撈好的 orderData/returnOrderData（跟 tiering 同一份資料、同一個 planDate），
  // 淨額＝叫貨−退貨，邏輯照抄 buildOrderStatsById_ 的做法，不是另外發明一套。
  const monthlyNet = {};
  if (pharmacy) {
    const yearAgo = new Date(planDate); yearAgo.setMonth(yearAgo.getMonth() - 11); yearAgo.setDate(1);
    for (let i = 0; i < 12; i++) {
      const dt = new Date(yearAgo.getFullYear(), yearAgo.getMonth() + i, 1);
      monthlyNet[`${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`] = 0;
    }
    orderData.rows.forEach(row => {
      if (String(row.c[orderData.colMap['店名']]?.v || '').trim() !== id) return;
      const d = parseGvizDate(row.c[orderData.colMap['訂單日期']]?.v || '');
      if (!d) return;
      const dateObj = new Date(String(d).replace(/\//g, '-'));
      if (isNaN(dateObj)) return;
      const key = `${dateObj.getFullYear()}-${String(dateObj.getMonth() + 1).padStart(2, '0')}`;
      if (!(key in monthlyNet)) return;
      monthlyNet[key] += parseFloat(row.c[orderData.colMap['總金額']]?.v || 0) || 0;
    });
    returnOrderData.rows.forEach(row => {
      if (String(row.c[returnOrderData.colMap['店名']]?.v || '').trim() !== id) return;
      const d = parseGvizDate(row.c[returnOrderData.colMap['退貨日期']]?.v || '');
      if (!d) return;
      const dateObj = new Date(String(d).replace(/\//g, '-'));
      if (isNaN(dateObj)) return;
      const key = `${dateObj.getFullYear()}-${String(dateObj.getMonth() + 1).padStart(2, '0')}`;
      if (!(key in monthlyNet)) return;
      monthlyNet[key] -= parseFloat(row.c[returnOrderData.colMap['退貨金額']]?.v || 0) || 0;
    });
  }
  const monthlyOrders = Object.keys(monthlyNet).sort().map(key => ({ key, total: Math.round(monthlyNet[key]) }));

  return json({
    ok: true,
    id,
    name: pharmacy ? pharmacy.name : (screeningRow ? screeningRow.name : id),
    type: pharmacy ? 'customer' : 'new-store',
    stage: pharmacy ? '正式客戶' : (screeningRow ? screeningRow.stage : null),
    address: pharmacy ? pharmacy.address : null,
    city: pharmacy ? pharmacy.city : null,
    district: pharmacy ? pharmacy.district : null,
    greeting: pharmacy ? pharmacy.greeting : null,
    phone: pharmacy ? pharmacy.phone : null,
    excludeReason,
    tiering,
    monthlyOrders,
    rules: myRules,
    followups: myFollowups,
  });
}

// 店家規則：新增/修改都轉送 GAS（gas-backend 的 addRule/updateRule action）
// 2026-10-28：addRule/updateRule/deleteRule 這幾個 action GAS 那邊現在要求帶 token，密鑰從
// wrangler secret（env.PLANNER_API_TOKEN）讀，由 Worker 代填——planner.html／store-drawer.js
// 只打這支 Worker 端點，永遠不會看到密鑰，也不會直接打 GAS。`{ ...body, action, token }`
// 故意把 action/token 放在展開之後，就算前端自己塞了同名欄位也會被這裡蓋掉，不是前端說了算。
async function handlePlannerRules(request, env) {
  const body = await request.json();
  const action = body.delete ? 'deleteRule' : (body.ruleId ? 'updateRule' : 'addRule');
  const res = await fetch(GAS_VISIT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, action, token: env.PLANNER_API_TOKEN }),
    redirect: 'follow',
  });
  const data = await res.json();
  return json({ ok: !!data.success, ...data });
}

// 待追蹤：新增/結案/刪除都轉送 GAS（gas-backend 的 addFollowup/resolveFollowup/deleteFollowup action），
// token 代填的理由同上。
async function handlePlannerFollowups(request, env) {
  const body = await request.json();
  const action = body.delete ? 'deleteFollowup' : (body.resolve ? 'resolveFollowup' : 'addFollowup');
  const res = await fetch(GAS_VISIT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, action, token: env.PLANNER_API_TOKEN }),
    redirect: 'follow',
  });
  const data = await res.json();
  return json({ ok: !!data.success, ...data });
}

// ============================================================
// 工具函式
// ============================================================
function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: CORS_HEADERS
  });
}
