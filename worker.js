// ============================================================
// 藥局業務智能 Worker v3
// 新增：POST/GET /customer-status — 客戶狀態管理（死客戶標記）
// ============================================================
// 環境變數：
//   GEMINI_API_KEY
//   SHEET_PHARMACY  = 1qJ62K5Hd2bKP9DdQTjwJOOy0njNICMSPiayW7YJZdNM
//   SHEET_VISIT     = 10rofUuKtji4tKGyUv6cvbsiTEq1ynRP0zJxohc3l68U
//   SHEET_PRODUCT   = 1tyJYRWVPl7F5kprBylR_WbbIVayIWQEUxdQ-2sCL-cM
//   SHEET_ORDER     = 13HB7e9mzL0H6Nhfyl-AKhjO8M_GElnqPldTk-u-0ni8
// ============================================================

const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_MODEL_PRO = 'gemini-2.5-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const GEMINI_URL_PRO = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL_PRO}:generateContent`;

const GAS_URL = 'https://script.google.com/macros/s/AKfycbxdCQvTWLTLtTLrpL5gpZZrvsEAujA0xnQ9gOiX0o23mR2y6ZTJHtSDqEmt_LmqZBFA/exec';
const GAS_VISIT_URL = 'https://script.google.com/macros/s/AKfycbxBDS60OKaAhxeS53qrN7O1TbbN_wHSaJgwKJeFVjgr8ZuxpS-RV6aRu-uEwTJwKvzN9g/exec';

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
//   newPhAddress, newPhCity, healthInsurance, source,
//   createdAt
//
// 【有效象限值】前端 QMETA 與此處 AI prompt 必須一致
//   ui | ii | iii | iv | pool | dad | pending_newph | newph | invoice
//   AI 只建議前五種（dad / pending_newph / newph / invoice 由系統自動設定）
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
// 【/dad-pharmacies — 爸爸客戶清單】
//   GET  → { ok, ids: ['C116',...] }（首次呼叫自動用 DEFAULT_DAD_IDS 初始化）
//   POST → body: { id, action: 'add'|'remove' }，回傳 { ok, ids }
//   KV key: dad:pharmacies
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
        return await handleCustomerStatus(request);
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

      // ★ 產品照片（R2）
      if (path.startsWith('/product-photo/') && request.method === 'GET') {
        const key = decodeURIComponent(path.replace('/product-photo/', ''));
        return await handleProductPhoto(key, env);
      }

      // ★ 藥局資訊總覽（出貨明細 + 退貨紀錄 + 盤點歷史）
      if (path === '/pharmacy-profile' && request.method === 'GET') {
        return await handlePharmacyProfile(request, env);
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
      phone:       get('電話'),
      area:        get('實體資料夾'),
      city:        get('縣市'),
      district:    get('行政區'),
      chatTopics:  get('聊天話題'),
      background:  get('家庭背景'),
      profileNote: get('藥師備註'),
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
async function handleVisitsSummary(env) {
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

  const summary = {};
  rows.forEach(row => {
    const id   = row.c[colMap['店名']]?.v || '';
    const date = parseGvizDate(row.c[colMap['拜訪日期']]?.v || '');
    const tags = row.c[colMap['Tags']]?.v || '';
    const actionItems = row.c[colMap['Action Items']]?.v || '';
    if (!id) return;

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
  const [pharmaciesRes, visitsRes, ordersRes, dadRaw] = await Promise.all([
    handleGetPharmacies(null, env).then(r => r.json()),
    handleVisitsSummary(env).then(r => r.json()),
    handleOrdersSummary(env).then(r => r.json()),
    env.TODOS_KV.get('dad:pharmacies'),
  ]);

  const pharmacies  = pharmaciesRes.pharmacies || [];
  const visitMap    = visitsRes.summary || {};
  const orderMap    = ordersRes.summary || {};
  const dadIds      = new Set(dadRaw ? JSON.parse(dadRaw) : []);

  const scored = pharmacies.map(p => {
    const v = visitMap[p.id] || {};
    const o = orderMap[p.id] || {};

    const daysSince   = v.daysSince ?? 999;
    const totalAmount = o.totalAmount || 0;
    const hasPending  = v.hasPending || false;
    const neverOrdered = !o.orderCount;
    const neverVisited = !v.visitCount;

    const isDead = totalAmount > 0 && daysSince > 180 && !v.visitCount && !dadIds.has(p.id);
    if (isDead) return null;

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
// 8. 客戶狀態管理（代理到 Google Apps Script）
// ============================================================
async function handleCustomerStatus(request) {
  if (request.method === 'GET') {
    const res = await fetch(`${GAS_URL}?action=getStatuses`, {
      redirect: 'follow',
    });
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
    const allowedFields = ['task','quadrant','pharmacyId','pharmacyName','scheduledDate','done','doneAt','aiSuggestions','resolution','relatedTodoIds','sourceVisitId','sourceVisitDate','type','newPhAddress','newPhCity','healthInsurance','source'];
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
const DEFAULT_DAD_IDS = ['C116','C117','C118','C119','C120','C121','C122','C123','C124','C125','C126','C129'];

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
// 17. 爸爸客戶清單（KV 持久化）
// ============================================================
async function handleDadPharmacies(request, env) {
  if (request.method === 'GET') {
    const raw = await env.TODOS_KV.get('dad:pharmacies');
    if (!raw) {
      // 首次呼叫自動初始化
      await env.TODOS_KV.put('dad:pharmacies', JSON.stringify(DEFAULT_DAD_IDS));
      return json({ ok: true, ids: DEFAULT_DAD_IDS });
    }
    return json({ ok: true, ids: JSON.parse(raw) });
  }
  if (request.method === 'POST') {
    const body = await request.json();
    const { id, action } = body;
    if (!id || !action) return json({ error: '缺少 id 或 action' }, 400);
    const raw = await env.TODOS_KV.get('dad:pharmacies');
    const ids = new Set(raw ? JSON.parse(raw) : DEFAULT_DAD_IDS);
    if (action === 'add') ids.add(id);
    else if (action === 'remove') ids.delete(id);
    else return json({ error: 'action 必須是 add 或 remove' }, 400);
    const updated = [...ids];
    await env.TODOS_KV.put('dad:pharmacies', JSON.stringify(updated));
    return json({ ok: true, ids: updated });
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
async function fetchGvizSheet(sheetId, sheetName) {
  const base = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:json`;
  const url = sheetName ? `${base}&sheet=${encodeURIComponent(sheetName)}` : base;
  const res = await fetch(url);
  const text = await res.text();
  const jsonStr = text.replace(/^.*?({.*}).*$/s, '$1');
  const data = JSON.parse(jsonStr);
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

async function handleInventoryCandidates(request, env) {
  const reqUrl = new URL(request.url);
  const pharmacy = reqUrl.searchParams.get('pharmacy') || '';
  const session  = reqUrl.searchParams.get('session') || '';
  if (!pharmacy) return json({ error: '缺少 pharmacy 參數' }, 400);

  const [orderData, returnData, returnOrderData, productData] = await Promise.all([
    fetchGvizSheet(env.SHEET_ORDER, null),
    fetchGvizSheet(env.SHEET_RETURN, null),
    fetchGvizSheet(env.SHEET_RETURN_ORDER, null),
    fetchGvizSheet(env.SHEET_PRODUCT, null),
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
    fetchGvizSheet(env.SHEET_ORDER, null),
    fetchGvizSheet(env.SHEET_PRODUCT, null),
    fetchGvizSheet(env.SHEET_RETURN, null),
    fetchGvizSheet(env.SHEET_RETURN_ORDER, null),
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
// 工具函式
// ============================================================
function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: CORS_HEADERS
  });
}
