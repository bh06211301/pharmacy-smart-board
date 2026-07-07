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

    const isDead = totalAmount > 0 && daysSince > 180 && !v.visitCount;
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
    const allowedFields = ['task','quadrant','pharmacyId','pharmacyName','scheduledDate','done','doneAt','aiSuggestions','resolution','relatedTodoIds','sourceVisitId','sourceVisitDate','type'];
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

輸出 JSON：
{"suggestedQuadrant":"ui|ii|iii|iv","suggestions":["準備事項1","準備事項2","準備事項3"]}

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
// 15. 依產品查詢進貨藥局與日期
// ============================================================
async function handleProductOrders(request, env) {
  const reqUrl = new URL(request.url);
  const product = reqUrl.searchParams.get('product') || '';
  if (!product) return json({ error: '缺少 product 參數' }, 400);

  const sheetId = env.SHEET_ORDER;
  const sheetUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:json`;
  const res = await fetch(sheetUrl);
  const text = await res.text();
  const jsonStr = text.replace(/^.*?({.*}).*$/s, '$1');
  const data = JSON.parse(jsonStr);

  const rows = data?.table?.rows || [];
  const cols = data?.table?.cols || [];
  const colNames = cols.map(c => c.label);
  const colMap = {};
  cols.forEach((c, i) => { colMap[c.label] = i; });

  const productCols = ['品名', '產品名稱', '商品名稱', '藥品名稱', '產品', '品項'];
  const dateCols   = ['出貨日期', '日期', '訂購日期', '訂單日期', '出貨時間', '出貨年月日'];

  const productColName = productCols.find(n => colMap[n] !== undefined);
  const dateColName    = dateCols.find(n => colMap[n] !== undefined);

  if (!productColName) {
    return json({ ok: false, columns: colNames, result: [], error: '找不到品名欄位' });
  }

  function parseDate(cell) {
    if (!cell) return '';
    if (cell.f) return cell.f;
    const v = String(cell.v || '');
    if (v.startsWith('Date(')) {
      const parts = v.replace('Date(', '').replace(')', '').split(',').map(Number);
      return `${parts[0]}-${String(parts[1] + 1).padStart(2, '0')}-${String(parts[2]).padStart(2, '0')}`;
    }
    return v;
  }

  const pharmacyMap = {};
  rows.forEach(row => {
    const pName = String(row.c[colMap[productColName]]?.v || '');
    if (!pName.includes(product)) return;
    const pharmacy = row.c[colMap['店名_備份']]?.v || '';
    if (!pharmacy) return;
    const date = dateColName ? parseDate(row.c[colMap[dateColName]]) : '';
    if (!pharmacyMap[pharmacy]) pharmacyMap[pharmacy] = { pharmacy, orders: [] };
    pharmacyMap[pharmacy].orders.push({ product: pName, date });
  });

  const result = Object.values(pharmacyMap)
    .map(p => {
      const dates = [...new Set(p.orders.map(o => o.date))].filter(Boolean).sort().reverse();
      return { pharmacy: p.pharmacy, orderCount: p.orders.length, lastDate: dates[0] || '', recentDates: dates.slice(0, 5) };
    })
    .sort((a, b) => (b.lastDate > a.lastDate ? 1 : -1));

  return json({ ok: true, product, result, productColName, dateColName, columns: colNames });
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
