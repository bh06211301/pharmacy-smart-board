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
import { parseIcsEvents_ } from './ics-utils.js';

const GEMINI_MODEL = 'gemini-3.5-flash-lite';
const GEMINI_MODEL_PRO = 'gemini-3.5-flash-lite';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const GEMINI_URL_PRO = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL_PRO}:generateContent`;

// 2026-11-09 外勤模式規格安全整頓：這三支 GAS exec 網址原本直接寫死在這個檔案裡，而這個 repo
// 是 public——等於任何人都看得到。改成 wrangler secret（env.GAS_URL／env.GAS_VISIT_URL／
// env.SCREENING_API_URL），呼叫處對應改讀 env，不再用這三個模組常數。
// 新開藥局篩選（new-pharmacy-screening）的 Web App，讀「藥局每日異動追蹤」篩選分頁。
// 這份試算表沒有開「知道連結的人可檢視」（跟其他 SHEET_* 不同），gviz 直接讀會是登入頁，
// 改用它自己的 doGet API（已經是 FIELD 對應好的 JSON，含 stage/stageDate），密碼走 wrangler secret：SCREENING_API_TOKEN

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
//   POST → body: { id, status:'dead'|'active', note }，寫入 env.GAS_VISIT_URL action:'updatePharmacyFlag' field:'dead'
//          status='dead' 且 note 空白時預設寫入「死客戶」（欄位只要非空值就算死客戶，不能寫空字串）
//
// 【/dad-pharmacies — 爸爸客戶清單，2026-10-24 改為讀寫主表「負責人」欄】
//   GET  → { ok, ids: ['C116',...] }（讀 /pharmacies 裡 owner === '老爸' 的 id）
//   POST → body: { id, action: 'add'|'remove' }，回傳 { ok, ids }
//          寫入 env.GAS_VISIT_URL action:'updatePharmacyFlag' field:'dad'，value 為 '老爸'（add）或 ''（remove，預設即我）
//
// ============================================================

// ============================================================
// 路由
// ============================================================
export default {
  async fetch(request, env, ctx) {
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
        return await handleVisitsSummary(env, ctx);
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
        return await handleAddVisit(request, env);
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
        return await handlePlannerPlan(request, env, ctx);
      }

      // ★ Phase 2：儲存當天的錨點清單＋確定路線（A1 第①③欄用，KV 持久化）
      if (path === '/api/plan' && request.method === 'POST') {
        return await handleSavePlan(request, env);
      }

      // ★ 今日清單階段二：今日行程（唯一正本，anchors/route 不再存 KV）
      if (path === '/api/today-plan' && request.method === 'GET') {
        return await handleGetTodayPlan(request, env, ctx);
      }
      if (path === '/api/today-plan' && request.method === 'POST') {
        return await handleSaveTodayPlan(request, env);
      }

      // ★ field-v2 階段1：外勤模式單站狀態更新（只改一列，不是整天覆蓋）
      if (path === '/api/today-plan/row' && request.method === 'POST') {
        return await handleUpdateTodayPlanRow(request, env);
      }

      // ★ 2026-10-27 新增：客戶叫貨健康度分級（只讀分析，跟 /api/plan 完全獨立、不影響 SmartRoute 評分）
      // 只在 wrangler dev 本機測，還沒決定要不要留、要不要 commit
      if (path === '/api/customer-tiers' && request.method === 'GET') {
        return await handleCustomerTiers(env);
      }

      // ★ A2 店家規則管理頁：全部店家＋全部規則（含店名）
      if (path === '/api/rules' && request.method === 'GET') {
        return await handleListPlannerRules(env, ctx);
      }

      // ★ 店家規則（代理到 GAS 的 addRule/updateRule）
      if (path === '/api/rules' && request.method === 'POST') {
        return await handlePlannerRules(request, env);
      }

      // ★ A3 待追蹤管理頁：全部待追蹤（含店名、距上次接觸、對排程的影響）
      if (path === '/api/followups' && request.method === 'GET') {
        return await handleListPlannerFollowups(env, ctx);
      }

      // ★ 待追蹤（代理到 GAS 的 addFollowup/resolveFollowup/updateFollowup）
      if (path === '/api/followups' && request.method === 'POST') {
        return await handlePlannerFollowups(request, env, ctx);
      }

      // ★ Phase 2：A8 藥局檔案抽屜要的單店全部資料（分級、規則、待追蹤）
      if (path === '/api/store' && request.method === 'GET') {
        return await handleStoreDetail(request, env, ctx);
      }

      // ★ A10 新店開發：頂部數字＋每欄卡片＋轉換率
      if (path === '/api/funnel/overview' && request.method === 'GET') {
        return await handleFunnelOverview(request, env, ctx);
      }

      // ★ A10「記結果」：advance/drop/keep/confirmed
      if (path === '/api/funnel/result' && request.method === 'POST') {
        return await handleFunnelResult(request, env, ctx);
      }

      // ★ A5 本週：7 天概況（跑哪區/已確定路線/日曆事件）＋這週要做的（逾期客戶/待追蹤/請款待收）
      if (path === '/api/week' && request.method === 'GET') {
        return await handleWeekOverview(request, env, ctx);
      }

      // ★ A5 本週：存某一天選定的區（讀取→合併→寫回 plan:{date}，不會洗掉已存的 anchors/route）
      if (path === '/api/week/day' && request.method === 'POST') {
        return await handleSaveWeekDay(request, env);
      }

      // ★ A7 客戶總覽：頂部分級統計＋依區域分組的格子資料（正式客戶＋開發中店），純讀取
      if (path === '/api/overview' && request.method === 'GET') {
        return await handleOverview(env, ctx);
      }

      // ★ A6 本月：月曆格資料（拜訪量/預計區域/週期色帶）＋本月累計統計，純讀取，只能查上個月/本月/下個月
      if (path === '/api/month' && request.method === 'GET') {
        return await handleMonthOverview(request, env, ctx);
      }

      // ★ 2026-11-04：新店定位永久快取（地圖模式用，避免每次重新整理都重打 Places API）
      if (path === '/api/geo' && request.method === 'POST') {
        return await handleSaveGeo(request, env);
      }

      return json({ error: '找不到這個 endpoint' }, 404);

    } catch (err) {
      console.error('Worker error:', err);
      return json({ error: err.message }, 500);
    }
  },

  // Plan C 預熱：wrangler.toml 的 cron trigger 排程呼叫這支（平日台灣時間 07:00）。
  async scheduled(event, env, ctx) {
    ctx.waitUntil(warmPlannerCaches_(env));
  },
};

// ============================================================
// Plan C 預熱（2026-11-04）：排程觸發時把 /api/plan、/api/week、/api/followups 會用到的全部
// 資料源都強制重新抓一次寫進 KV（不管目前快取新不新鮮，一律覆蓋——跟平常讀取走的 swrFetch_
// 「只在超過4分鐘才背景重讀」邏輯不一樣，預熱本來就是要強制換新）。直接呼叫各支 ...Raw_()
// 函式（跟平常讀取共用同一份 fetch/parse 邏輯，不是另外複製一份），寫入的 KV key 格式要跟
// swrFetch_() 用的完全一致，才能真的讓之後的讀取吃到剛預熱好的資料。
// 每個來源各自 try/catch，一個來源失敗（例如 GAS 剛好在重啟）不影響其他來源照常預熱完成。
// ============================================================
async function warmCacheKey_(env, cacheKey, fetchFn) {
  try {
    const data = await fetchFn();
    if (env.TODOS_KV) await env.TODOS_KV.put(cacheKey, JSON.stringify({ data, cachedAt: Date.now() }));
    return { cacheKey, ok: true };
  } catch (e) {
    console.warn('預熱失敗（不影響其他來源，排程本身沒有人在等回應）', cacheKey, e && e.message || e);
    return { cacheKey, ok: false, error: String(e && e.message || e) };
  }
}

async function warmPlannerCaches_(env) {
  const tasks = [
    warmCacheKey_(env, 'visits:summary', () => fetchVisitsSummaryRaw_(env)),
    warmCacheKey_(env, `gviz:${env.SHEET_PHARMACY}:新客戶資料表_AppSheet`, () => fetchGvizSheetRaw_(env.SHEET_PHARMACY, '新客戶資料表_AppSheet')),
  ];
  if (env.SCREENING_API_TOKEN) {
    tasks.push(warmCacheKey_(env, 'screening:rows', () => fetchScreeningRowsRaw_(env)));
  }
  if (env.SHEET_PLANNER) {
    tasks.push(warmCacheKey_(env, `gviz:${env.SHEET_PLANNER}:待追蹤`, () => fetchGvizSheetRaw_(env.SHEET_PLANNER, '待追蹤')));
    tasks.push(warmCacheKey_(env, `gviz:${env.SHEET_PLANNER}:店家規則`, () => fetchGvizSheetRaw_(env.SHEET_PLANNER, '店家規則')));
    tasks.push(warmCacheKey_(env, `gviz:${env.SHEET_PLANNER}:階段歷程`, () => fetchGvizSheetRaw_(env.SHEET_PLANNER, '階段歷程')));
  }
  if (env.SHEET_ORDER_MASTER) {
    tasks.push(warmCacheKey_(env, `gviz:${env.SHEET_ORDER_MASTER}:`, () => fetchGvizSheetRaw_(env.SHEET_ORDER_MASTER, null)));
  }
  tasks.push(warmCacheKey_(env, `gviz:${env.SHEET_RETURN_ORDER}:`, () => fetchGvizSheetRaw_(env.SHEET_RETURN_ORDER, null)));
  if (env.SHEET_CONTRACT) {
    tasks.push(warmCacheKey_(env, `gviz:${env.SHEET_CONTRACT}:客戶合約`, () => fetchGvizSheetRaw_(env.SHEET_CONTRACT, '客戶合約')));
  }
  // 日曆／天氣不走 swrFetch_（它們自己的 1小時/3小時快取機制，key 格式不一樣），直接呼叫
  // 既有函式讓它們照自己的邏輯判斷要不要重新抓，預熱不用特別處理。
  tasks.push(fetchGoogleCalendarEvents_(env).then(() => ({ cacheKey: 'gcal:events', ok: true })).catch(e => ({ cacheKey: 'gcal:events', ok: false, error: String(e && e.message || e) })));
  tasks.push(fetchWeatherForecast_(env).then(() => ({ cacheKey: 'weather:forecast', ok: true })).catch(e => ({ cacheKey: 'weather:forecast', ok: false, error: String(e && e.message || e) })));

  const results = await Promise.all(tasks);
  const failed = results.filter(r => !r.ok);
  console.log(`Plan C 預熱完成：${results.length - failed.length}/${results.length} 成功` + (failed.length ? `，失敗：${failed.map(f => f.cacheKey).join('、')}` : ''));
  return results;
}

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
// 改走 fetchGvizSheet() 的 SWR 快取。這支幾乎每個 SmartRoute 端點（/api/plan、/api/store、
// /api/rules、/api/followups）都會呼叫，客戶資料變動頻率很低，快取值得做。ctx/cacheMeta 可選：
// 直接走 /pharmacies 路由時不用傳（沒有 waitUntil 背景重讀能力也不影響正確性，只是那次請求
// 自己不會觸發背景更新），handlePlannerPlan 等 3 個目標端點會傳兩者進來。
async function handleGetPharmacies(request, env, ctx, cacheMeta) {
  const sheetName = '新客戶資料表_AppSheet';
  // 2026-11-11：field-v2/funnel 的正式代號候選比對需要抓到剛在 AppSheet 建好、還落在 SWR
  // 4分鐘快取窗口內的新客戶——帶 ?fresh=1 跳過 fetchGvizSheet() 的快取，直接即時抓一次，
  // 順便把 KV 快取也更新成這份新資料（cache key 跟 fetchGvizSheet() 用同一套格式，接下來
  // 的一般請求不用等 4 分鐘窗口過期就能吃到新資料）。不帶這個參數時完全照舊。
  const fresh = request && new URL(request.url).searchParams.get('fresh') === '1';
  let rows, colMap;
  if (fresh) {
    const raw = await fetchGvizSheetRaw_(env.SHEET_PHARMACY, sheetName);
    rows = raw.rows; colMap = raw.colMap;
    if (env.TODOS_KV) {
      const cacheKey = `gviz:${env.SHEET_PHARMACY}:${sheetName}`;
      try {
        await env.TODOS_KV.put(cacheKey, JSON.stringify({ data: { rows, colMap }, cachedAt: Date.now() }));
      } catch (e) {
        console.warn('fresh=1 更新快取失敗（不影響這次回應，已經拿到新資料了）', e && e.message || e);
      }
    }
  } else {
    const entry = await fetchGvizSheet(env.SHEET_PHARMACY, sheetName, env, ctx, cacheMeta);
    rows = entry.rows; colMap = entry.colMap;
  }

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

// 拜訪紀錄表是全系統唯一一份從上線累積到現在、每筆拜訪都要寫一行、含「原始逐字稿」長文字
// 欄位的大表，被 /api/plan、/api/week、/api/followups、/api/overview、/api/store 各自讀一次。
// 改用 swrFetch_()。這張表是由另一套系統（pharmacy-visit-app 的 GAS webhook）寫入，這支 worker
// 自己沒有對應的寫入端點可以主動清快取，純靠 SWR 的 4 分鐘門檻＋排程預熱控制新鮮度。
async function fetchVisitsSummaryRaw_(env) {
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
      summary[id] = { lastDate: '', lastDateMs: -Infinity, visitCount: 0, hasPending: false };
    }
    summary[id].visitCount++;
    // bug（2026-11-12 修正）：date 是 parseGvizDate() 吐出的未補零字串（如 "2026/9/18"），
    // 直接用字串比大小會把 "9/18" 誤判成比 "11/11" 新（'9' > '1'）。改成轉成真正的時間戳比較。
    if (date) {
      const ms = new Date(date.replace(/\//g, '-')).getTime();
      if (!isNaN(ms) && ms > summary[id].lastDateMs) {
        summary[id].lastDateMs = ms;
        summary[id].lastDate = date;
      }
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
  return { ok: true, count: Object.keys(result).length, summary: result };
}

async function handleVisitsSummary(env, ctx, cacheMeta) {
  const entry = await swrFetch_(env, ctx, 'visits:summary', () => fetchVisitsSummaryRaw_(env));
  noteCacheTime_(cacheMeta, entry.cachedAt);
  return json(entry.data);
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
    const res = await fetch(env.GAS_VISIT_URL, {
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

// 2026-11-10 field-v2 階段1：移除「9. 業務待辦清單」整組（/todos 路由、handleTodos、
// env.GAS_URL）——全專案找不到任何前端呼叫，轉送到的 GAS（customer-status-gas）doGet
// 本來就沒實作 getTodos，一直回「未知 action」，見 docs/SPEC.md 第11節。部署時記得連
// GAS_URL 的 wrangler secret 一併刪除（見部署步驟）。

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
// 外勤模式規格階段1前置：field-v2 驗收要能指定寫 _TEST 分頁，這裡跟 GAS 端用同一組白名單
// （VisitAppWebhook.js 的 VISIT_SHEET_WHITELIST）。不帶 sheetName 時完全不轉送這個欄位，
// 等同現行行為（GAS 端收不到就預設寫「拜訪紀錄表」），不影響既有呼叫端。
const ADD_VISIT_SHEET_WHITELIST = ['拜訪紀錄表', '拜訪紀錄_TEST'];

async function handleAddVisit(request, env) {
  const body = await request.json();
  if (body.sheetName && ADD_VISIT_SHEET_WHITELIST.indexOf(body.sheetName) < 0) {
    return json({ success: false, error: '不允許的分頁名稱：' + body.sheetName }, 400);
  }
  // 轉換欄位名稱以符合 VisitAppWebhook.js 格式
  const gasPayload = {
    action:      'addVisit',
    visitId:     body.visitId,
    pharmacy:    body.pharmacyName || body.pharmacy || '',
    date:        body.date,
    visitType:   body.purpose || body.visitType || '',
    note:        body.content  || body.note || '',
  };
  if (body.sheetName) gasPayload.sheetName = body.sheetName;
  const res = await fetch(env.GAS_VISIT_URL, {
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
    const writeRes = await fetch(env.GAS_VISIT_URL, {
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

// parseGvizDate() 吐出的「Y/M/D」是未補零字串，不能直接字串比大小排序（"9/18" 會被誤判
// 比 "11/11" 新）。排序要用這個轉成時間戳再比；空字串/解析失敗回 0（排到最舊，不影響其他
// 有效日期的相對順序）。
function dateSortKey_(dateStr) {
  if (!dateStr) return 0;
  const ms = new Date(String(dateStr).replace(/\//g, '-')).getTime();
  return isNaN(ms) ? 0 : ms;
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

// 共用：讀取訂單主檔所有列。改走 fetchGvizSheet() 的 SWR 快取——這是算分數用的大表，
// /api/plan、/api/store、/api/followups、/api/week 都會整批讀一次。
async function fetchOrderMasterRows(env, ctx, cacheMeta) {
  if (!env.SHEET_ORDER_MASTER) throw new Error('未設定 SHEET_ORDER_MASTER');
  return fetchGvizSheet(env.SHEET_ORDER_MASTER, null, env, ctx, cacheMeta);
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
// ============================================================
// 2026-11-04 Plan C：讀取類 API 的 KV 快取改成「先給舊資料，背景更新」（stale-while-revalidate）。
// 量過（見 2026-11-03 那批 commit）：60～240秒的固定 TTL，只要兩次操作間隔超過 TTL，使用者就會
// 撞到一次 20~40 秒的冷啟動（Google Sheets gviz + GAS screening 本身就慢，不是我們程式碼的問題）。
// 改成 KV 不設硬性過期，存 {data, cachedAt}；讀的時候：
//   - 沒有快取 → 只能同步等這次抓完（第一次使用、或 KV 被清過）。
//   - 有快取且在 SWR_STALE_MS（4分鐘，使用者定的門檻）內 → 直接回，不额外動作。
//   - 有快取但超過 4 分鐘 → 立刻回這份舊資料給這次請求（使用者不用等），同時用 ctx.waitUntil()
//     在背景重新抓一次寫回 KV，下一個人來讀就是新的了。背景重讀失敗只記 log，不影響這次回應。
// 搭配 wrangler.toml 的 cron 預熱（平日 07:00 讀一輪全部資料源寫進 KV）跟/api/plan、/api/week、
// /api/followups 一定會傳 cacheMeta 收集每個子來源的 cachedAt，相輔相成：預熱後资料通常都在
// 4分鐘門檻內，一整天大部分時間讀到的都是「新鮮」的，只有真的冷啟動或背景重讀失敗時才會看到
// 比較舊的 cachedAt。
// ============================================================
const SWR_STALE_MS = 4 * 60 * 1000;

async function swrFetch_(env, ctx, cacheKey, fetchFn) {
  const now = Date.now();
  let cached = (env && env.TODOS_KV) ? await env.TODOS_KV.get(cacheKey, 'json') : null;
  // 防呆：這次改版前，同一批 key 存的是舊格式（直接存 {rows,colMap} 之類，沒有 cachedAt），
  // 雖然舊格式的 TTL 最長 240 秒、照時間算早就過期，但保險起見還是判一下形狀，
  // 不符合就當沒快取，走下面同步抓一次的路徑，不要把舊格式當新格式用（cachedAt 會是
  // undefined，NaN 比較一律是 false，會被誤判成「很新鮮」又回傳一個少了 .data 的物件）。
  if (cached && typeof cached.cachedAt !== 'number') cached = null;
  if (cached) {
    if (now - cached.cachedAt >= SWR_STALE_MS && ctx && ctx.waitUntil && env && env.TODOS_KV) {
      ctx.waitUntil(
        fetchFn()
          .then(data => env.TODOS_KV.put(cacheKey, JSON.stringify({ data, cachedAt: Date.now() })))
          .catch(e => console.warn('SWR背景重讀/寫入失敗（不影響這次回應，已經回舊資料了）', cacheKey, e && e.message || e))
      );
    }
    return cached; // 不管新舊，這次請求都先用它，不等背景重讀
  }
  const data = await fetchFn();
  const entry = { data, cachedAt: now };
  // 2026-11-04 使用者要求：KV put 失敗（例如超過每日額度）不能讓這次 API 失敗——資料已經
  // 抓到手上了（data 是好的），只是這次沒辦法寫進快取，下次請求會再抓一次，頂多多打幾次
  // Google，不影響正確性，照樣把 entry 回給呼叫端。
  if (env && env.TODOS_KV) {
    try {
      await env.TODOS_KV.put(cacheKey, JSON.stringify(entry));
    } catch (e) {
      console.warn('KV put 失敗（不影響這次回應，已經拿到新資料了）', cacheKey, e && e.message || e);
    }
  }
  return entry;
}

// cacheMeta：呼叫端（handlePlannerPlan/handleWeekOverview/handleListPlannerFollowups）傳一個
// { oldest: Infinity } 物件進來，每支 SWR 快取函式讀完都呼叫 noteCacheTime_() 回報自己這份資料
// 的 cachedAt，最後呼叫端取 cacheMeta.oldest 當這次組合回應裡「最舊的一份資料」的時間，顯示給
// 使用者看「資料時間」。不需要回報的呼叫端（直接走 /visits-summary 這類單一端點）可以不傳。
function noteCacheTime_(cacheMeta, cachedAt) {
  if (cacheMeta && typeof cachedAt === 'number' && cachedAt < cacheMeta.oldest) cacheMeta.oldest = cachedAt;
}
function cacheMetaCachedAt_(cacheMeta) {
  return (cacheMeta && cacheMeta.oldest !== Infinity) ? cacheMeta.oldest : Date.now();
}

// 不經任何快取，直接即時抓一次——fetchGvizSheet() 的 SWR 包裝、跟 warmPlannerCaches_()
// 的排程預熱共用這支，不要各寫一份一樣的 fetch+parse 邏輯。
async function fetchGvizSheetRaw_(sheetId, sheetName) {
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

async function fetchGvizSheet(sheetId, sheetName, env, ctx, cacheMeta) {
  const cacheKey = `gviz:${sheetId}:${sheetName || ''}`;
  const entry = await swrFetch_(env, ctx, cacheKey, () => fetchGvizSheetRaw_(sheetId, sheetName));
  noteCacheTime_(cacheMeta, entry.cachedAt);
  return entry.data;
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

  const res = await fetch(env.GAS_VISIT_URL, {
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
  const returns = Object.values(myReturnOrders).sort((a, b) => dateSortKey_(b.date) - dateSortKey_(a.date));

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
  const inventory = Object.values(mySessions).sort((a, b) => dateSortKey_(b.date) - dateSortKey_(a.date));

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

// 改呼叫 fetchGvizSheet()，吃它的 SWR 快取——SHEET_PLANNER 的「待追蹤」／「店家規則」／
// 「階段歷程」三個分頁分別被 5/4/4 處各自獨立讀取，同一次頁面載入裡同一張表常常被重新讀好幾次。
// 對應的寫入端點（handlePlannerFollowups／handlePlannerRules／handleFunnelResult）已經補上
// invalidateGvizCache_() 清快取，避免使用者剛改完資料卻看到舊的（SWR 不設 TTL，被清掉的 key
// 下一次讀取會同步重新抓一次，不是回舊資料）。
async function fetchGvizRows(sheetId, sheetName, env, ctx, cacheMeta) {
  const { rows, colMap } = await fetchGvizSheet(sheetId, sheetName, env, ctx, cacheMeta);
  return rows.map(row => {
    const get = (label) => row.c[colMap[label]]?.v ?? '';
    return { get };
  });
}

async function invalidateGvizCache_(env, sheetId, sheetName) {
  if (!env || !env.TODOS_KV || !sheetId) return;
  await env.TODOS_KV.delete(`gviz:${sheetId}:${sheetName || ''}`).catch(() => {});
}

// 2026-10-31 修正：呼叫端常常直接傳 fetchGvizRows() 的 f.get('期限') 這種原始 gviz 格式
// （例如 "Date(2026,10,2)"），new Date(...) 對這種字串會解析失敗變成 Invalid Date，
// 回傳 null。但呼叫端幾乎都寫成 `-daysBetween(...)`，JS 對 null 取負號會轉型成 -0（也就是 0），
// 不會維持 null，造成「只要有填期限，天數差一律被當成 0」——新店待追蹤分數因此永遠落在
// 「剩3天內」這個最高分級、正式客戶的到期判斷永遠觸發、主選單待追蹤徽章永遠多算。
// 這裡先用既有的 parseGvizDate() 正規化（它對已經是一般日期字串的輸入是no-op，不影響其他呼叫端）。
function daysBetween(fromDateStr, toDate) {
  if (!fromDateStr) return null;
  const from = new Date(String(parseGvizDate(fromDateStr)).replace(/\//g, '-'));
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
// 2026-11-01：「不拜訪」特別通路排除（例：C135政治大學選舉研究中心、C047——SPEC.md 4.5 記過的
// 手動標記），A1 評分跟 A2 店家規則清單都要排除，且這條判斷優先於「負責人=老爸保留」：不拜訪的店
// 即使負責人不是老爸也要排除，老爸的店只有在「不是不拜訪」時才保留在 A2。兩邊共用這支，不要各寫一次。
function isMarkedDoNotVisit_(p) {
  return p.status === '不拜訪';
}

function isEligibleForTiering_(p) {
  if (p.deadReason) return false;
  if (isMarkedDoNotVisit_(p)) return false;
  if (p.owner === '老爸') return false;
  if (PLANNER_CONFIG.excludedCities.indexOf(p.city) >= 0) return false;
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

// 主選單「待追蹤」紅色數字徽章＝3天內到期（含逾期）的未完成待追蹤件數，不含「下次經過」這種沒有
// 具體日期的（算不出「幾天內」）。handlePlannerPlan（A1）跟 handleListPlannerFollowups（A3）都要用
// 同一個數字，2026-10-31 抽成共用函式，不要兩邊各寫一次同樣的算法。
function computeFollowupsDueSoonBadge_(followupRows) {
  const now = new Date();
  return followupRows.filter(f => {
    if ((f.get('狀態') || '未完成') !== '未完成') return false;
    if ((f.get('期限類型') || '下次經過') !== '指定日期前') return false;
    const deadline = f.get('期限');
    if (!deadline) return false;
    const daysUntil = -daysBetween(deadline, now);
    return daysUntil <= 3;
  }).length;
}

// 待追蹤拆成「已到期」跟「還沒到期」兩組：已到期的整筆變成 anchors（來源標「待追蹤」），不參加排名；
// 還沒到期的（含「下次經過」這種沒有具體日期的）留在原地，乘上 followupMultiplier 影響排序分。
// 期限類型＝下次經過：沒有具體日期可比，一律視為「還沒到期」。
// 2026-11-02：從 handlePlannerPlan 內部抽成獨立函式，/api/week（buildCustomerOverview_）也要用，
// 不要兩邊各寫一次同樣的拆分邏輯。
function splitFollowups_(followupRows, storeId, planDate) {
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

// 「這週要做的」拖放/按鈕指派到某天時，判斷某店是否已經有一筆未完成、事項開頭是 prefix 的待追蹤
// （目前只有「拜訪：」在用這支嚴格版——判斷「逾期沒去的店」已經排過，見 handleWeekOverview），
// 避免同一件事在「這週要做的」清單跟日曆上重複出現。「請款」改用下面放寬版的
// findActiveBillingFollowup_（2026-11-02 松江健保案例，手動建立的舊待追蹤文字不是標準格式，
// 嚴格比對抓不到）。回傳該筆的期限（可能是 null，表示期限類型是「下次經過」），沒有找到回 null。
function findActiveFollowupByPrefix_(followupRows, storeId, prefix) {
  const hit = followupRows.find(f =>
    f.get('店家代號') === storeId &&
    (f.get('狀態') || '未完成') === '未完成' &&
    String(f.get('事項') || '').startsWith(prefix)
  );
  return hit ? { followupId: hit.get('待追蹤ID') || null, deadline: hit.get('期限') || null } : null;
}

// 請款的比對刻意放寬成「事項文字包含『請款』」而不是嚴格比對「請款：」開頭——2026-11-02 實測踩到：
// 松江健保(C034)已經有一筆手動建立、文字是「請款一半 跨年後一半」（不是本功能產生的標準格式）的
// 未完成待追蹤，嚴格比對抓不到，導致同一家店同時出現在「有期限的待追蹤」跟「還沒指定日期的請款」
// 兩份清單。「拜訪」判斷（上面 findActiveFollowupByPrefix_ 的用法）維持嚴格比對「拜訪：」開頭不能
// 一起放寬——店家規則/待追蹤常見「拜訪前先打電話」這類跟「逾期沒去」完全無關的文字，放寬會誤把
// 真正逾期的店藏起來，比重複顯示還危險；請款這邊兩個方向都比較安全（頂多少顯示一個本來就該顯示的
// 提醒，不會讓真正該收的錢憑空消失，金額仍然算在頂部 banner 裡）。
function findActiveBillingFollowup_(followupRows, storeId) {
  const hit = followupRows.find(f =>
    f.get('店家代號') === storeId &&
    (f.get('狀態') || '未完成') === '未完成' &&
    String(f.get('事項') || '').includes('請款')
  );
  return hit ? { followupId: hit.get('待追蹤ID') || null, deadline: hit.get('期限') || null } : null;
}

// 店家是否有自己的「請款規則」（店家規則分頁，規則類型＝請款規則，狀態＝有效）——有的話代表這家店
// 不走通用的 7 個月寄賣整理規則，例如 C014 來福藥局「隔月5號請款（不走寄賣7個月）」（docs/SPEC.md
// 3.2 記過的決定）。2026-11-02 發現這個決定只記在文件裡，從沒真的寫進計算邏輯，C014 的寄賣訂單
// 照樣被通用7個月規則判定成「待整理」，出現在 A5「還沒指定日期的請款」清單——跟文件決定矛盾，修正。
function hasActiveBillingRule_(ruleRows, storeId) {
  return ruleRows.some(r =>
    r.get('店家代號') === storeId &&
    r.get('規則類型') === '請款規則' &&
    (r.get('狀態') || '有效') === '有效'
  );
}

// 寄賣整理彙整：掃排除規則篩過的名單裡「寄賣中(資料夾)」的訂單，算每家店的 allTotal（不管多久）/
// staleCount/staleMaxMonths/staleTotal（只算 >= consignmentCleanupMonths 個月、且這家店沒有自己
// 請款規則的）。/api/plan（handlePlannerPlan）跟 /api/week（handleWeekOverview）共用，確保兩邊
// 「寄賣待整理」判定一致——此前兩邊各自複製一份同樣的迴圈，這次順便併成一份，不然這個 bug 修了
// 一邊、另一邊會繼續錯。
function buildConsignmentByStore_(orderRows, orderColMap, eligibleIds, ruleRows, referenceDate) {
  const byStore = {};
  orderRows.forEach(row => {
    const status = String(row.c[orderColMap['紅單實體狀態']]?.v || '').trim();
    if (status !== '寄賣中(資料夾)') return;
    const id = String(row.c[orderColMap['店名']]?.v || '').trim();
    if (!id || !eligibleIds.has(id)) return;
    const d = parseGvizDate(row.c[orderColMap['訂單日期']]?.v || '');
    if (!d) return;
    const orderDate = new Date(String(d).replace(/\//g, '-'));
    if (isNaN(orderDate)) return;
    const amount = parseFloat(row.c[orderColMap['總金額']]?.v || 0) || 0;
    const monthsSince = monthsSinceJs(orderDate, referenceDate);
    const entry = (byStore[id] = byStore[id] || { allTotal: 0, staleCount: 0, staleMaxMonths: 0, staleTotal: 0 });
    entry.allTotal += amount;
    if (monthsSince >= PLANNER_CONFIG.consignmentCleanupMonths && !hasActiveBillingRule_(ruleRows, id)) {
      entry.staleCount += 1;
      entry.staleTotal += amount;
      entry.staleMaxMonths = Math.max(entry.staleMaxMonths, monthsSince);
    }
  });
  return byStore;
}

// 正式客戶總覽（tier/倍數/合約寄賣狀態），/api/plan（handlePlannerPlan）跟 /api/week
// （handleWeekOverview）共用，避免兩邊各自算一套倍數/寄賣門檻、長期兜不起來。
// 回傳陣列不含「到期待追蹤變成錨點」的副作用——那是 handlePlannerPlan 自己按當天規劃日才要做的事，
// 每筆項目上掛一個 _dueFollowups（到期的待追蹤清單），由呼叫端決定要不要用、用完記得清掉這個內部欄位。
function buildCustomerOverview_(eligible, statsById, p70AvgMonthly, medianAvgMonthly, ruleRows, visitMap, followupRows, contractByStore, consignmentByStore, planDate) {
  return eligible.map(p => {
    const stat = statsById[p.id];
    const { tier, intervalDays, alert } = classifyTierAndAlert_(stat, p70AvgMonthly, medianAvgMonthly);
    const avgMonthly = stat.hasOrders ? stat.avgMonthly : 0;
    const ruleStatus = evalRuleStatus(ruleRows, p.id, planDate);
    const visitDate = (visitMap[p.id] || {}).lastDate || '';
    const orderDate = stat.hasOrders ? stat.lastOrderDate : '';
    const lastContactDate = laterDateOrNull_(visitDate, orderDate);

    const { due, notDue } = splitFollowups_(followupRows, p.id, planDate);
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
    const ratioCapForTier = PLANNER_CONFIG.tierRatioCap[tier];
    const ratio = ratioCapForTier ? Math.min(rawRatio, ratioCapForTier) : rawRatio;
    const ratioCapped = ratio !== rawRatio;

    const contractAmount = contractByStore[p.id];
    const isContracted = contractAmount !== undefined;
    const consignment = consignmentByStore[p.id] || null;
    let consignmentMultiplier = 1;
    if (!isContracted && consignment && consignment.staleCount > 0) {
      consignmentMultiplier = PLANNER_CONFIG.consignmentMultiplier;
    }

    const rankScoreBase = ratio * avgMonthly;
    const rankScore = rankScoreBase * followupMultiplier * consignmentMultiplier;
    const score = Math.round(rankScore);

    return {
      id: p.id, name: p.name, type: 'customer', stage: '正式客戶', tier, intervalDays,
      city: p.city, district: p.district,
      daysSince, ratio: Math.round(ratio * 100) / 100, rawRatio: Math.round(rawRatio * 100) / 100, ratioCapped, avgMonthly,
      score, rankScore: Math.round(rankScore), followupMultiplier, followupItems: notDueItems, ruleStatus, alert,
      isContracted, contractAmount: isContracted ? contractAmount : null,
      consignmentAllTotal: consignment ? Math.round(consignment.allTotal) : 0,
      consignmentStaleCount: consignment ? consignment.staleCount : 0,
      consignmentStaleMaxMonths: consignment ? consignment.staleMaxMonths : 0,
      consignmentStaleTotal: consignment ? Math.round(consignment.staleTotal) : 0,
      consignmentMultiplier,
      reason: (daysSince === null
          ? `從未拜訪也從未叫貨，倍數固定 1.0`
          : `${daysSince} / ${intervalDays} 天 = ${(Math.round(rawRatio * 100) / 100)} 倍` +
            (ratioCapped ? `（封頂算 ${ratio}）` : '')) +
        `・月均 $${Math.round(avgMonthly).toLocaleString()}` +
        (followupMultiplier !== 1 ? `・待追蹤×${followupMultiplier}` : '') +
        (consignmentMultiplier !== 1 ? `・寄賣×${consignmentMultiplier}` : '') +
        (notDueItems.length ? `・${notDueItems.join('、')}` : ''),
      _dueFollowups: due,
    };
  });
}

// A1「今天可以跑的區」（2026-11-02）。分區表／座標都在 planner-config.js，這裡只有計算邏輯。
function haversineKm_(a, b) {
  const toRad = x => x * Math.PI / 180;
  const R = 6371;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}
// 直線距離換算大概車程分鐘數：近距離市區車速慢、遠距離有國道可以快，分兩段估，乘 1.3 修正直線
// 距離跟實際路網的落差——這是粗估，不是真實路網距離，前端要清楚標示「約」，不能當精確預估。
function estimateDriveMinutes_(km) {
  const roadKm = km * 1.3;
  const speedKmh = km <= 20 ? 28 : 50;
  return Math.round(roadKm / speedKmh * 60);
}
// 哪個區屬於哪一類分區：基隆/新竹用縣市比對（原公式就是這樣，因為有些區名跟台北的區同名），
// 其餘用行政區名稱比對，都比對不到就是 regionFallbackLabel。
function regionGroupOf_(city, district) {
  for (const g of PLANNER_CONFIG.regionGroups) {
    if (g.cities && g.cities.indexOf(city) >= 0) return g;
    if (g.districts && g.districts.indexOf(district) >= 0) return g;
  }
  return null;
}
// 每類分區的代表車程：區內各行政區車程分鐘數的平均（區跨好幾個行政區，車程本來就是模糊的大概值，
// 不是精確到單一店家的距離）。基隆/新竹用縣市層級代表座標（districtCoords 裡那個城市名當 key）。
function regionMinutesOf_(group) {
  const keys = [...(group.cities || []), ...(group.districts || [])];
  const mins = keys
    .map(k => PLANNER_CONFIG.districtCoords[k])
    .filter(Boolean)
    .map(coord => estimateDriveMinutes_(haversineKm_(PLANNER_CONFIG.regionHomeBase, coord)));
  if (!mins.length) return null;
  return Math.round(mins.reduce((a, b) => a + b, 0) / mins.length);
}
// 彙整每類分區的今天可以跑的區概況：新店家數/最高倍數、客戶該去家數（倍數≥1）、送貨家數
// （anchors 裡 source==='送貨' 的，已經是當天的，不用再篩日期）、大概車程。
// allPharmacies 用全部正式客戶（不是排除規則篩過的 list）查送貨錨點的區域——送貨錨點本來就
//「不管店家是不是排除規則篩過的名單內（老爸/新竹的送貨單也要列出來）」，查區域也要用同一份全量名單，
// 不然老爸的店的送貨會因為不在 list 裡被誤判成「其他」。
function buildTodayRegions_(list, anchors, allPharmacies) {
  const byGroupKey = {};
  PLANNER_CONFIG.regionGroups.forEach(g => { byGroupKey[g.key] = { key: g.key, label: g.label, newStoreCount: 0, maxRatio: 0, customerDueCount: 0, deliveryCount: 0 }; });
  const fallback = { key: 'other', label: PLANNER_CONFIG.regionFallbackLabel, newStoreCount: 0, maxRatio: 0, customerDueCount: 0, deliveryCount: 0 };
  function bucketOf(city, district) {
    const g = regionGroupOf_(city, district);
    return g ? byGroupKey[g.key] : fallback;
  }
  list.forEach(item => {
    const b = bucketOf(item.city, item.district);
    if (item.type === 'new-store') {
      b.newStoreCount += 1;
      if (item.ratio !== null && item.ratio > b.maxRatio) b.maxRatio = item.ratio;
    } else if (item.type === 'customer' && item.ratio >= 1) {
      b.customerDueCount += 1;
    }
  });
  const pharmacyById = {};
  allPharmacies.forEach(p => { pharmacyById[p.id] = p; });
  const screeningById = {};
  list.filter(item => item.type === 'new-store').forEach(item => { screeningById[item.id] = item; });
  anchors.forEach(a => {
    if (a.source !== '送貨') return;
    const p = pharmacyById[a.id] || screeningById[a.id];
    const b = p ? bucketOf(p.city, p.district) : fallback;
    b.deliveryCount += 1;
  });
  const groups = PLANNER_CONFIG.regionGroups.map(g => ({ ...byGroupKey[g.key], estimateMinutes: regionMinutesOf_(g) }));
  if (fallback.newStoreCount || fallback.customerDueCount || fallback.deliveryCount) groups.push({ ...fallback, estimateMinutes: null });
  // 2026-11-02：依急迫程度排序——有新店的區在前（高倍數優先，同倍數看新店家數多的），沒有新店的區排最後
  groups.sort((a, b) => {
    const aHas = a.newStoreCount > 0;
    const bHas = b.newStoreCount > 0;
    if (aHas !== bHas) return aHas ? -1 : 1;
    if (b.maxRatio !== a.maxRatio) return b.maxRatio - a.maxRatio;
    return b.newStoreCount - a.newStoreCount;
  });
  return groups;
}

// ============================================================
// 今日清單階段二（2026-11-06）：「今日行程」表讀寫共用設定與輔助函式
// ============================================================
// 2026-11-08：B2/B3 驗收通過＋使用者實測正式網站2026-11-27確認正常，正式切到「今日行程」。
const TODAY_PLAN_SHEET_NAME = '今日行程';
const TODAY_PLAN_COLS_ = [
  '日期', '順序', '店家代號', '店名', '地址', '類型', '拜訪目的', '目的備註', '要做的事', '金額',
  '停留分鐘', '停留手動', '預計到達', '來源', '已確定', '狀態', '備註', '更新時間',
];
// 「來源」是「這筆資料當初怎麼進今日清單」的單一值，跟 gas-backend/PlannerSetup.js 的
// PLANNER_TODAY_PLAN_SOURCES 同一組值——錨點類（會還原進 anchors）：錨點/送貨/待追蹤/本週排/
// 寄賣對帳；第②欄類（還原進 selectedCol2Ids，不進 anchors）：第②欄/選區。
const TODAY_PLAN_ANCHOR_SOURCES_ = ['錨點', '送貨', '待追蹤', '本週排', '寄賣對帳'];

async function fetchTodayPlanRows_(env, ctx, cacheMeta) {
  if (!env.SHEET_PLANNER) return [];
  return await fetchGvizRows(env.SHEET_PLANNER, TODAY_PLAN_SHEET_NAME, env, ctx, cacheMeta);
}
function todayPlanRowToObj_(r) {
  return {
    date: r.get('日期'), seq: r.get('順序'), storeId: r.get('店家代號'), name: r.get('店名'),
    address: r.get('地址'),
    types: String(r.get('類型') || '').split('、').filter(Boolean),
    purposes: String(r.get('拜訪目的') || '').split('、').filter(Boolean),
    purposeNote: r.get('目的備註') || '', autoTask: r.get('要做的事') || '',
    amount: r.get('金額') || '', stayMin: r.get('停留分鐘') || '',
    stayManual: r.get('停留手動') === 'TRUE', arrival: r.get('預計到達') || '',
    source: r.get('來源') || '', confirmed: r.get('已確定') === 'TRUE',
    status: r.get('狀態') || '待去', note: r.get('備註') || '',
    updatedAt: r.get('更新時間') || '',
  };
}
// 把今日清單一列的畫面狀態（planner.html 的 todayList row）轉成要存進「今日行程」的欄位物件
// （給 POST /api/today-plan 轉送 GAS 用，欄位名稱對齊 TODAY_PLAN_COLS_，日期/更新時間由 GAS 補）。
function todayPlanRowFromClient_(r) {
  return {
    順序: r.seq ?? '', 店家代號: r.storeId || '', 店名: r.name || '', 地址: r.address || '',
    類型: Array.isArray(r.types) ? r.types.join('、') : (r.types || ''),
    拜訪目的: Array.isArray(r.purposes) ? r.purposes.join('、') : (r.purposes || ''),
    目的備註: r.purposeNote || '', 要做的事: r.autoTask || '', 金額: r.amount ?? '',
    停留分鐘: r.stayMin ?? '', 停留手動: r.stayManual ? 'TRUE' : 'FALSE',
    預計到達: r.arrival || '', 來源: r.source || '',
    已確定: r.confirmed ? 'TRUE' : 'FALSE', 狀態: r.status || '待去', 備註: r.note || '',
  };
}
// 當天最後一站「離開時間」當作「收工」的近似值（最後一站預計到達 + 它的停留分鐘）——不是真正
// 到家的時間，因為「今日行程」表沒有存最後一段回程的車程分鐘數（規格 B0 沒有這個欄位，純前端
// 算路線時的車程資料也不會持久化）。weekly.html／monthly.html 顯示時都用這個近似值。
function approxFinishTimeFromRows_(rows) {
  if (!rows.length) return null;
  const last = rows[rows.length - 1];
  const m = String(last.arrival || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const stay = parseInt(last.stayMin, 10) || 0;
  const totalMin = parseInt(m[1], 10) * 60 + parseInt(m[2], 10) + stay;
  const h = Math.floor(totalMin / 60) % 24, mm = totalMin % 60;
  return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

async function handlePlannerPlan(request, env, ctx) {
  const url = new URL(request.url);
  const dateParam = url.searchParams.get('date');
  const planDate = dateParam ? new Date(dateParam) : new Date();
  if (isNaN(planDate)) return json({ error: 'date 格式不對，要 YYYY-MM-DD' }, 400);

  // Plan C：收集這次回應組合用到的每份資料的 cachedAt，取最舊的一份當「資料時間」回給前端
  // （weekly.html/planner.html 右上角顯示用，見 cacheMetaCachedAt_ 註解）。
  const cacheMeta = { oldest: Infinity };
  const [pharmaciesRes, visitsRes, screeningRows, followupRows, ruleRows, orderData, returnOrderData, contractData, stageHistoryRows] = await Promise.all([
    handleGetPharmacies(null, env, ctx, cacheMeta).then(r => r.json()),
    handleVisitsSummary(env, ctx, cacheMeta).then(r => r.json()),
    env.SCREENING_API_TOKEN
      ? fetchScreeningRows_(env, ctx, cacheMeta)
      : Promise.resolve([]),
    env.SHEET_PLANNER ? fetchGvizRows(env.SHEET_PLANNER, '待追蹤', env, ctx, cacheMeta) : Promise.resolve([]),
    env.SHEET_PLANNER ? fetchGvizRows(env.SHEET_PLANNER, '店家規則', env, ctx, cacheMeta) : Promise.resolve([]),
    env.SHEET_ORDER_MASTER ? fetchOrderMasterRows(env, ctx, cacheMeta) : Promise.resolve({ rows: [], colMap: {} }),
    fetchGvizSheet(env.SHEET_RETURN_ORDER, null, env, ctx, cacheMeta),
    // 「客戶合約」目前沒開「知道連結的人可檢視」，gviz 會拿到 Google 登入頁而不是 JSON，
    // 用 try/catch 吞掉，當作沒有合約資料（全部店都走沒合約的 7 個月規則），不要讓整個 /api/plan 掛掉
    env.SHEET_CONTRACT
      ? fetchGvizSheet(env.SHEET_CONTRACT, '客戶合約', env, ctx, cacheMeta).catch(() => ({ rows: [], colMap: {}, fetchError: true }))
      : Promise.resolve({ rows: [], colMap: {} }),
    // 2026-11-02：A10「階段歷程」——新店倍數的起算日改用「最近一筆階段歷程日期」，沒有歷程時才 fallback
    // 用篩選分頁的「進入階段日期」（見下面 screeningRows.forEach）。分頁可能還不存在（會回空陣列，不報錯）。
    env.SHEET_PLANNER ? fetchGvizRows(env.SHEET_PLANNER, '階段歷程', env, ctx, cacheMeta) : Promise.resolve([]),
  ]);

  const allPharmacies = pharmaciesRes.pharmacies || [];
  const visitMap = visitsRes.summary || {};
  const latestStageHistoryDate = latestStageHistoryDateByStore_(stageHistoryRows);

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
  // 之前版本掃全部客戶，誤把死客戶 C015/C038 列進來）。彙整每家店目前「寄賣中(資料夾)」的全部訂單
  // （allTotal 不管多久，staleXxx 只算 >= consignmentCleanupMonths 個月、且這家店沒有自己請款規則
  // 的，見 buildConsignmentByStore_），下面依有沒有合約分兩種處理。
  const consignmentByStore = buildConsignmentByStore_(orderData.rows, orderData.colMap, eligibleIds, ruleRows, planDate);

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

  // 正式客戶：倍數改用「最後接觸日」＝拜訪日跟叫貨日取比較近的那個（2026-10-27 第二版，拿掉上一版
  // 「只看拜訪日、從未拜訪排最前」的做法）。兩者都沒有時倍數固定 1.0（不特別拉最前也不墊底）。
  // 間隔依分級（大咖/潛力新店/冷淡/一般）決定，見 PLANNER_CONFIG.tierIntervalDays。
  // 2026-11-02：計算本體抽到 buildCustomerOverview_()，/api/week 也會呼叫同一份，這裡只處理
  // 「到期待追蹤變成錨點」這個 handlePlannerPlan 專屬的副作用，然後把 _dueFollowups 清掉再塞進 list。
  const customerOverview = buildCustomerOverview_(eligible, statsById, p70AvgMonthly, medianAvgMonthly, ruleRows, visitMap, followupRows, contractByStore, consignmentByStore, planDate);
  customerOverview.forEach(item => {
    item._dueFollowups.forEach(f => anchors.push({ id: item.id, name: item.name, source: '待追蹤', item: f.item, deadline: f.deadline || null }));
    delete item._dueFollowups;
    list.push(item);
  });

  // 新店開發（篩選分頁，決定＝要去，階段不是轉正式／放棄）：間隔依階段，倍數公式仍是舊版
  // min(倍數,ratioCap)*weight，但起算日 2026-11-02 改成「該店最近一筆階段歷程日期」（沒有歷程時
  // fallback 用篩選分頁的進入階段日期，向下相容還沒用過 A10「記結果」的店）——每次記結果（含維持）
  // 都會讓倍數重新起算，不會因為卡在同一階段很久、但其實業務一直在拜訪，就被誤判成「卡住」。
  // 2026-10-28 補：篩選分頁的「階段」欄位沒有自動連動──它追蹤的是「藥局每日異動追蹤」稅籍比對出來的
  // 開發線索（木木好用這條路徑的 id 是 ce73d892dd），跟 pharmacy-visit-app「新案開發」當場建檔走的是
  // 另一套暫存代號機制（木木好那次用的是 f3e4049d69→C137），兩套系統從來沒互相通知過彼此，所以同一家店
  // 有可能先被稅籍比對列成開發線索，後來又從另一條路徑直接建檔成正式客戶，篩選分頁那一列卻永遠停在
  // 建檔前的階段文字（不會變成「轉正式」）。這裡沒有欄位可以直接查「已轉正」，只能用店名比對（見
  // possiblyConvertedScreeningIds_）：篩選分頁這一列的店名如果跟某個正式客戶完全相同，視為已經轉正，
  // 不再列進新店開發清單——A10 用同一份比對結果改標「可能已轉正，請確認」而不是直接濾掉。
  const possiblyConvertedIds_ = possiblyConvertedScreeningIds_(screeningRows, allPharmacies);
  screeningRows.forEach(r => {
    const { decision, stage, id } = r;
    if (decision !== '要去') return;
    if (!stage || stage === '轉正式' || stage === '放棄') return;
    if (possiblyConvertedIds_.has(id)) return;
    const interval = PLANNER_CONFIG.stageIntervalDays[stage];
    if (!interval) return; // 不認得的階段文字，跳過不猜
    const effectiveDate = latestStageHistoryDate[id] || r.stageDate;
    const daysSince = daysBetween(effectiveDate, planDate);
    if (daysSince === null) return;
    const ratio = daysSince / interval;
    const intervalScore = Math.min(ratio, PLANNER_CONFIG.ratioCap) * PLANNER_CONFIG.intervalScoreWeight;
    const followup = scoreFollowups(followupRows, id, planDate);
    const score = Math.round(intervalScore + followup.score);
    const ruleStatus = evalRuleStatus(ruleRows, id, planDate);
    list.push({
      id, name: r.name, type: 'new-store', stage,
      city: r.city, district: r.district, address: r.address,
      daysSince, interval, ratio: Math.round(ratio * 100) / 100, ratioTier: ratioTierOf(ratio),
      score, followupItems: followup.items, ruleStatus,
      reason: `${daysSince} / ${interval} 天 = ${(Math.round(ratio * 100) / 100)} 倍` +
        (followup.items.length ? `・${followup.items.join('、')}` : ''),
    });
  });

  // 新店定位永久快取（見 handleSaveGeo 註解）：查 geo:<id>，地址跟目前這筆資料的地址一樣才附上
  // lat/lng——地址不一樣（例如業務把地址改對了）就當作沒有記錄，讓前端 resolveStoreLocation_()
  // 重新查一次。地址比對前先把「臺」正規化成「台」，不然同義異體字會被誤判成「地址改過」。
  if (env.TODOS_KV) {
    const newStoreItems = list.filter(item => item.type === 'new-store');
    const geoEntries = await Promise.all(
      newStoreItems.map(item => env.TODOS_KV.get(`geo:${item.id}`, 'json').catch(() => null))
    );
    newStoreItems.forEach((item, i) => {
      const geo = geoEntries[i];
      if (!geo) return;
      if (normalizeCityChar_(geo.address || '') !== normalizeCityChar_(item.address || '')) return;
      item.lat = geo.lat;
      item.lng = geo.lng;
    });
  }

  // 每個項目標上屬於哪一類分區（A1「今天可以跑的區」用，2026-11-02）：前端「選這區」要知道
  // 這個區的新店有哪幾家，直接讀這個欄位去篩，不用在前端另外複製一份分區比對邏輯。
  list.forEach(item => {
    const g = regionGroupOf_(item.city, item.district);
    item.region = g ? g.key : 'other';
  });

  // 排序：倍數≥1（該去了）＞ 倍數<1（還沒到）；組內用 score（＝倍數×月均叫貨×待追蹤倍率）遞減排序，
  // 不設上限；同分再用月均決勝。
  function bucketOf(item) { return item.ratio >= 1 ? 1 : 0; }
  list.sort((a, b) => {
    const diff = bucketOf(b) - bucketOf(a);
    if (diff !== 0) return diff;
    return (b.score - a.score) || ((b.avgMonthly || 0) - (a.avgMonthly || 0));
  });

  // 今日清單階段二（2026-11-06）：anchors/route 不再存 KV，改用「今日行程」表當正本。
  //   1. 任何 id 只要今日行程已經有一列（不管狀態，含「移除」），就不要再用現場算出來的送貨/
  //      待追蹤到期/本週排預設值蓋過去——使用者已經對這家店做過決定了（見規格 B 補充第2點）。
  //   2. 今日行程裡「來源」是錨點類、狀態不是「移除」的列，還原回 anchors。
  // 第②欄勾選（來源=第②欄/選區）跟每列的拜訪目的/備註/停留分鐘/順序，純前端狀態，整份
  // todayPlanRows 原始資料回給前端自己還原（見 planner.html loadPlan()），不在這裡處理。
  const dateKey = planDate.toISOString().slice(0, 10);
  const todayPlanAllRows = (await fetchTodayPlanRows_(env, ctx, cacheMeta))
    .map(todayPlanRowToObj_)
    .filter(r => r.date === dateKey);
  const todayPlanIds = new Set(todayPlanAllRows.map(r => r.storeId).filter(Boolean));

  const keptAnchors = anchors.filter(a => !todayPlanIds.has(a.id));
  anchors.length = 0;
  anchors.push(...keptAnchors);
  todayPlanAllRows.forEach(r => {
    if (!TODAY_PLAN_ANCHOR_SOURCES_.includes(r.source) || r.status === '移除') return;
    if (anchors.some(a => a.id === r.storeId)) return;
    anchors.push({ id: r.storeId, name: r.name, source: r.source, item: r.autoTask || r.purposeNote || '', deadline: null });
  });
  const todayPlanRows = todayPlanAllRows.filter(r => r.status !== '移除').sort((a, b) => (parseInt(a.seq) || 0) - (parseInt(b.seq) || 0));
  // 狀態＝「移除」的列本身不顯示在畫面上，但前端存檔（整天覆蓋）時要知道它們存在，不然下次
  // 存檔送出的 rows 沒帶這幾筆，GAS 整天覆蓋會把它們一起刪掉，等於使用者按過的✕又復活了。
  const todayPlanRemovedIds = todayPlanAllRows.filter(r => r.status === '移除').map(r => ({ storeId: r.storeId, name: r.name, source: r.source }));

  // route（確定路線的站序陣列）這個舊概念被「今日行程」表的『順序』欄＋每列『預計到達』取代，
  // 固定回 null；實際順序/時間請讀 todayPlanRows。
  const route = null;
  let savedRegion = null, savedDepartMin = null, savedOrderMode = null;
  if (env.TODOS_KV) {
    const saved = await env.TODOS_KV.get(`plan:${dateKey}`, 'json');
    // 防呆（規格 B 補充第4點）：plan:{date} 如果還留著改版前的 anchors/route 欄位，只記警告、
    // 不使用——這個 key 現在只存這天的畫面設定（region/出發時間/順序模式）。
    if (saved && (saved.anchors || saved.route)) {
      console.warn(`plan:${dateKey} KV 裡還有舊的 anchors/route 欄位，已忽略不使用（今日清單階段二之後這兩個欄位只存在「${TODAY_PLAN_SHEET_NAME}」表）`);
    }
    if (saved) {
      savedRegion = saved.region || null;
      savedDepartMin = typeof saved.departMin === 'number' ? saved.departMin : null;
      savedOrderMode = saved.orderMode || null;
    }
  }

  // Phase 2：主選單紅色數字徽章用的全站統計（跟目前看的規劃日無關，一律以「現在」為準）——
  // 客戶＝倍數≥1.0的家數（DESIGN.md 2.1），待追蹤＝3天內到期件數（含逾期，不含「下次經過」這種沒有
  // 具體日期的，因為算不出「幾天內」）。徽章數字為0時前端不顯示。
  // 2026-11-01：新加「新店開發」徽章（SPEC 6.1「卡住家數」，原本這份規格從沒定義過公式，程式碼裡
  // 也沒有「卡住」的既有實作）——使用者確認比照「客戶」徽章同一套標準：新店（type==='new-store'）
  // 倍數≥1.0（代表已經超過該階段的建議間隔天數，進度卡住了），不是另外發明一套門檻。
  const badgeCustomers = list.filter(item => item.type === 'customer' && item.ratio >= 1).length;
  const badgeNewStoreStuck = list.filter(item => item.type === 'new-store' && item.ratio >= 1).length;
  const badgeFollowupsDueSoon = computeFollowupsDueSoonBadge_(followupRows);
  const todayRegions = buildTodayRegions_(list, anchors, allPharmacies);

  return json({
    ok: true,
    date: dateKey,
    recommended: list,
    anchors, route, savedRegion,
    savedDepartMin, savedOrderMode, todayPlanRows, todayPlanRemovedIds,
    todayRegions,
    badges: { customers: badgeCustomers, newStoreStuck: badgeNewStoreStuck, followupsDueSoon: badgeFollowupsDueSoon },
    p70AvgMonthly, medianAvgMonthly,
    // 2026-11-04：拜訪目的設定只維護一份（PLANNER_CONFIG.visitPurposes，planner-config.js），
    // 前端 planner.html 優先用這裡回傳的，本地那份只在讀不到 API 時當備用。
    config: { visitPurposes: PLANNER_CONFIG.visitPurposes },
    cachedAt: cacheMetaCachedAt_(cacheMeta), // Plan C：這次用到的資料裡最舊的一份是什麼時候抓的
    note: '2026-10-27 第二版：倍數改用「最後接觸日」(拜訪或叫貨取較近)，兩者都沒有固定倍數1.0；分級決定間隔；倍數≥1用倍數×月均排序不設上限；到期待追蹤移入 anchors 不參加排名，未到期的乘上 followupMultiplier；還沒套用 2 公里錨點半徑篩選；老爸/新竹縣市/狀態=不拜訪 已排除在推薦外，要在 A1 手動加成送貨錨點（等 A1 錨點 UI 做出來再接）。Phase 2：anchors/route 若當天已存檔會蓋掉系統預設值，見 /api/plan POST',
  });
}

// 2026-11-06 今日清單階段二：anchors/route 不再存這裡（改存「今日行程」表，見 /api/today-plan），
// 這支改成只存這天的畫面設定——出發時間（departMin，分鐘數）／順序模式（orderMode）。跟
// handleSaveWeekDay 一樣是讀取→合併→寫回，不會洗掉另一邊已經存的 region 欄位（這個 key 現在
// 三個欄位 region/departMin/orderMode 各自獨立讀寫，不是整包覆蓋）。
async function handleSavePlan(request, env) {
  const body = await request.json();
  const { date, departMin, orderMode } = body;
  if (!date) return json({ error: '缺少 date' }, 400);
  if (!env.TODOS_KV) return json({ error: '未設定 TODOS_KV' }, 500);
  const existing = (await env.TODOS_KV.get(`plan:${date}`, 'json')) || {};
  if (typeof departMin === 'number') existing.departMin = departMin;
  if (orderMode) existing.orderMode = orderMode;
  delete existing.anchors; delete existing.route; // 清掉舊版殘留欄位，不要讓防呆 log 一直噴警告
  existing.savedAt = new Date().toISOString();
  await env.TODOS_KV.put(`plan:${date}`, JSON.stringify(existing));
  return json({ ok: true });
}

// 今日清單階段二：GET 讀當天的今日行程（純讀取，走 fetchGvizRows 的 SWR 快取，跟待追蹤/
// 店家規則同一套，GAS 的 doGet 完全不用動）。排除狀態=「移除」的列，畫面本來就不該顯示它們；
// 這支是給 planner.html 重新整理/切日期時單獨還原用，/api/plan 本身也會回同一份 todayPlanRows
// （拿去還原 anchors），兩邊共用 todayPlanRowToObj_ 同一套轉換，不會兜不起來。
async function handleGetTodayPlan(request, env, ctx) {
  const url = new URL(request.url);
  const date = url.searchParams.get('date');
  if (!date) return json({ error: '缺少 date' }, 400);
  const cacheMeta = { oldest: Infinity };
  const rows = (await fetchTodayPlanRows_(env, ctx, cacheMeta))
    .map(todayPlanRowToObj_)
    .filter(r => r.date === date && r.status !== '移除')
    .sort((a, b) => (parseInt(a.seq) || 0) - (parseInt(b.seq) || 0));
  return json({ ok: true, date, rows, cachedAt: cacheMetaCachedAt_(cacheMeta) });
}

// POST 轉送 GAS 的 saveTodayPlan action（token 由 Worker 代填，前端永遠不會看到密鑰）。
// body: { date, rows, clientUpdatedAt }——rows 是前端 todayList 的畫面狀態，這裡轉成欄位名稱
// 對齊「今日行程」表的物件再送出（todayPlanRowFromClient_）。conflict 原樣轉給前端，由前端
// 決定要不要用試算表目前的資料覆蓋畫面；寫入成功（非 conflict）才清快取，避免使用者剛存檔
// 卻在幾分鐘內的 SWR 視窗看到舊資料。
async function handleSaveTodayPlan(request, env) {
  const body = await request.json();
  const { date, rows, clientUpdatedAt } = body;
  if (!date) return json({ error: '缺少 date' }, 400);
  if (!Array.isArray(rows)) return json({ error: 'rows 必須是陣列' }, 400);
  const res = await fetch(env.GAS_VISIT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'saveTodayPlan', sheetName: TODAY_PLAN_SHEET_NAME, date,
      rows: rows.map(todayPlanRowFromClient_), clientUpdatedAt,
      token: env.PLANNER_API_TOKEN,
    }),
    redirect: 'follow',
  });
  const data = await res.json();
  // conflict 回傳的 rows 是 GAS 那邊用中文欄名組的物件（todayPlanRowToObject_），跟這支 Worker
  // 自己 GET /api/today-plan、/api/plan 用的 todayPlanRowToObj_ 欄名不一樣——轉成同一套形狀，
  // 前端不用自己判斷「這份資料是從哪條路徑來的，欄名長怎樣」。
  if (data.conflict && Array.isArray(data.rows)) data.rows = data.rows.map(todayPlanObjFromGasRow_);
  if (data.success && !data.conflict) await invalidateGvizCache_(env, env.SHEET_PLANNER, TODAY_PLAN_SHEET_NAME);
  return json(data);
}
function todayPlanObjFromGasRow_(o) {
  return {
    date: o['日期'], seq: o['順序'], storeId: o['店家代號'], name: o['店名'], address: o['地址'],
    types: String(o['類型'] || '').split('、').filter(Boolean),
    purposes: String(o['拜訪目的'] || '').split('、').filter(Boolean),
    purposeNote: o['目的備註'] || '', autoTask: o['要做的事'] || '',
    amount: o['金額'] || '', stayMin: o['停留分鐘'] || '',
    stayManual: o['停留手動'] === 'TRUE', arrival: o['預計到達'] || '',
    source: o['來源'] || '', confirmed: o['已確定'] === 'TRUE',
    status: o['狀態'] || '待去', note: o['備註'] || '', updatedAt: o['更新時間'] || '',
  };
}

// field-v2 階段1：外勤模式單站狀態更新（已到／完成／跳過＋備註），只改一列，不是整天覆蓋
// ——外勤手機跟電腦 planner.html 可能同時在動同一天的今日行程，用 saveTodayPlan 整天覆蓋
// 會有互相蓋掉對方改動的風險。body: { date, storeId?, address?, patch:{狀態?,備註?,預計到達?},
// requestId? }，storeId 跟 address 至少要帶一個（店家代號優先，没代號的新店退回用地址定位，
// 跟 todayPlanRowFromClient_／docs/今日清單_規格.md「同一家店不得重複」判斷同一套慣例）。
// patch 白名單跟 GAS 端 handleUpdateTodayPlanRow_ 的 TODAY_PLAN_ROW_PATCHABLE_FIELDS_ 同步，
// Worker 跟 GAS 兩邊都各自擋一次（defense-in-depth，跟 ADD_VISIT_SHEET_WHITELIST 同一個慣例）。
// sheetName 可選帶「今日行程_TEST」，驗收時不用碰正式「今日行程」（跟 addVisit 的 sheetName
// 白名單同一套做法）；不帶就預設正式分頁，等同現行行為，不影響既有呼叫端。
// 2026-11-10 補 insertRow：找不到列時可以帶 insertRow 直接新增一列，給「臨時加一站／順路
// 補一家」的「加入今日行程」按鈕用（同一支端點，不另開新端點，使用者明確指示）。insertRow
// 沿用 todayPlanRowFromClient_ 同一套畫面狀態→欄位轉換，跟既有 saveTodayPlan 新增列時
// 信任層級一致，不像 patch 那樣限制白名單（這是「新增一整列」，本來就要給齊欄位）。
const TODAY_PLAN_ROW_PATCHABLE_FIELDS = ['狀態', '備註', '預計到達'];
const TODAY_PLAN_SHEET_WHITELIST = ['今日行程', '今日行程_TEST'];
async function handleUpdateTodayPlanRow(request, env) {
  const body = await request.json();
  const { date, storeId, address, patch, insertRow, requestId } = body;
  const sheetName = body.sheetName || TODAY_PLAN_SHEET_NAME;
  if (TODAY_PLAN_SHEET_WHITELIST.indexOf(sheetName) < 0) {
    return json({ error: '不允許的分頁名稱：' + sheetName }, 400);
  }
  if (!date) return json({ error: '缺少 date' }, 400);
  if (!storeId && !address) return json({ error: '缺少 storeId 或 address，無法定位這一列' }, 400);
  const hasPatch = patch && typeof patch === 'object' && Object.keys(patch).length > 0;
  const hasInsert = insertRow && typeof insertRow === 'object';
  if (!hasPatch && !hasInsert) return json({ error: '缺少 patch 或 insertRow' }, 400);
  if (hasPatch) {
    const badKeys = Object.keys(patch).filter(k => TODAY_PLAN_ROW_PATCHABLE_FIELDS.indexOf(k) < 0);
    if (badKeys.length) {
      return json({ error: 'patch 只能改 ' + TODAY_PLAN_ROW_PATCHABLE_FIELDS.join('/') + '，不認得：' + badKeys.join('、') }, 400);
    }
  }

  const res = await fetch(env.GAS_VISIT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'updateTodayPlanRow', sheetName,
      date, storeId, address, patch, insertRow: hasInsert ? todayPlanRowFromClient_(insertRow) : undefined,
      requestId, token: env.PLANNER_API_TOKEN,
    }),
    redirect: 'follow',
  });
  const data = await res.json();
  if (data.success && data.row) data.row = todayPlanObjFromGasRow_(data.row);
  if (data.success) await invalidateGvizCache_(env, env.SHEET_PLANNER, TODAY_PLAN_SHEET_NAME);
  return json(data);
}

// ============================================================
// 新店定位永久快取（2026-11-04）：地圖模式每次重新整理都會對沒有 lat/lng 的新店打一次 Places API
// (New)，這把 key 每日上限 300 次，很快會打爆。前端 resolveStoreLocation_() 查到座標之後呼叫這支
// 存進 KV（key: geo:<店家id>，不設過期），下次 /api/plan 回傳同一家新店時直接附上 lat/lng，
// 前端就不用再查。只接受服務範圍內的座標（跟 planner.html 的 SERVICE_AREA_BOUNDS_ 同一組數字），
// 範圍外直接拒絕——這不是試算表/GAS 寫入，只是 KV 快取，不需要另外的寫入金鑰（沿用這個 Worker
// 其他直接寫 KV 的端點，例如 /calendar-plan、/api/plan POST，本來就沒有 token 機制，用資料本身的
// 驗證把關；這裡用範圍檢查）。
const GEO_CACHE_BOUNDS_ = { minLat: 24.6, maxLat: 25.35, minLng: 120.9, maxLng: 122.0 };
// 「臺北市」(異體字) vs 「台北市」比地址字串用，跟 planner.html 同名函式邏輯一致。
function normalizeCityChar_(s) {
  return String(s || '').replace(/臺/g, '台');
}
async function handleSaveGeo(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: '請求格式錯誤' }, 400);
  }
  const { id, address, lat, lng } = body || {};
  if (!id || typeof lat !== 'number' || typeof lng !== 'number' || isNaN(lat) || isNaN(lng)) {
    return json({ error: '缺少必要欄位（id/lat/lng）' }, 400);
  }
  if (lat < GEO_CACHE_BOUNDS_.minLat || lat > GEO_CACHE_BOUNDS_.maxLat ||
      lng < GEO_CACHE_BOUNDS_.minLng || lng > GEO_CACHE_BOUNDS_.maxLng) {
    return json({ error: '座標超出服務範圍，拒絕儲存' }, 400);
  }
  if (!env.TODOS_KV) return json({ error: '未設定 TODOS_KV' }, 500);
  try {
    await env.TODOS_KV.put(`geo:${id}`, JSON.stringify({ address: address || '', lat, lng, savedAt: Date.now() }));
  } catch (e) {
    console.warn('/api/geo 寫入 KV 失敗', id, e && e.message || e);
    return json({ error: 'KV 寫入失敗' }, 500);
  }
  return json({ ok: true });
}

// ============================================================
// A5 本週（2026-11-02）：/api/week、/api/week/day
// docs/SPEC.md 5.6、docs/PROPOSAL-A5-weekly.md。
// ============================================================

// A5「本週」存某一天選的區：對 plan:{date} KV 做讀取→合併→寫回，不是覆蓋——這個 key 平常由
// handleSavePlan 存 anchors/route，這裡只加/改 region 欄位，不能把既有的 anchors/route 洗掉。
async function handleSaveWeekDay(request, env) {
  const body = await request.json();
  const { date, region } = body;
  if (!date) return json({ error: '缺少 date' }, 400);
  if (!env.TODOS_KV) return json({ error: '未設定 TODOS_KV' }, 500);
  const existing = (await env.TODOS_KV.get(`plan:${date}`, 'json')) || {};
  existing.region = region || null;
  await env.TODOS_KV.put(`plan:${date}`, JSON.stringify(existing));
  return json({ ok: true });
}

// Google 主要日曆（唯讀、單一私密 iCal 網址，env.GCAL_ICAL_URL 是 wrangler secret，不進 Git）。
// 展開好的事件陣列快取在 TODOS_KV（key 'gcal:events'）1 小時，不是存原始 ICS 文字——/api/week
// 每次呼叫只做陣列篩選，不會每次都重新解析。還沒設定 GCAL_ICAL_URL 時回空陣列，不報錯（天氣/日曆
// 都是這次「先預留位置」的項目，缺金鑰不該讓整個 /api/week 掛掉）。
async function fetchGoogleCalendarEvents_(env) {
  if (!env.GCAL_ICAL_URL) return [];
  if (env.TODOS_KV) {
    const cached = await env.TODOS_KV.get('gcal:events', 'json');
    if (cached && Date.now() - cached.fetchedAt < 3600 * 1000) return cached.events;
  }
  const icsText = await fetch(env.GCAL_ICAL_URL).then(r => r.text());
  const events = parseIcsEvents_(icsText);
  if (env.TODOS_KV) {
    // 2026-11-04：KV put 失敗不能讓 /api/week 整個掛掉，events 已經解析好了，照樣回傳，
    // 只是這次沒存到快取，下次呼叫會再重新解析一次 ICS，不影響正確性。
    try {
      await env.TODOS_KV.put('gcal:events', JSON.stringify({ fetchedAt: Date.now(), events }), { expirationTtl: 3600 });
    } catch (e) {
      console.warn('gcal:events 寫入KV失敗（不影響這次回應）', e && e.message || e);
    }
  }
  return events;
}

// 天氣（2026-11-03，A5/A6 共用）：中央氣象署開放資料平臺鄉鎮天氣預報(一週)，資料集 F-D0047-071
// （新北市，含汐止區——2026-11-03 用 wrangler dev 實測過，29 個行政區都在裡面，確認是正確代碼）。
// 固定只查「汐止區」當代表點（業務出發地，CLAUDE.md 已記錄），不是每個「今天可以跑的區」各自查一次
// 天氣——7 類分區橫跨新北/台北/桃園/新竹，要每區分別查會複雜很多，且天氣本來就是「今天大概狀況」
// 的參考用途，不是逐區精算，用單一代表點是刻意簡化，不是忘記做。
// 回傳形狀：{ 'YYYY-MM-DD': { maxTemp, minTemp, pop, description } }，date 範圍由氣象署資料決定
// （實測約是「現在」起算未來 7 天，12 小時一個時段），超出範圍的日期查無資料，前端不特別處理，
// 單純不顯示天氣小卡即可（跟「寄單狀態」佔位文字同一種「缺資料時優雅跳過」處理原則）。
// 快取在 TODOS_KV（key 'weather:forecast'）3 小時，跟使用者 2026-11-03 決定的時間一致。
async function fetchWeatherForecast_(env) {
  if (!env.CWA_API_KEY) return {};
  if (env.TODOS_KV) {
    const cached = await env.TODOS_KV.get('weather:forecast', 'json');
    if (cached && Date.now() - cached.fetchedAt < 3 * 3600 * 1000) return cached.byDate || {};
  }
  let byDate = {};
  try {
    const key = env.CWA_API_KEY.trim();
    const apiUrl = `https://opendata.cwa.gov.tw/api/v1/rest/datastore/F-D0047-071?Authorization=${encodeURIComponent(key)}&format=JSON`;
    const res = await fetch(apiUrl);
    const data = await res.json();
    if (res.ok && (data.success === 'true' || data.success === true)) {
      const districts = data.records?.Locations?.[0]?.Location || [];
      const target = districts.find(l => l.LocationName === '汐止區');
      if (target) byDate = buildDailyWeatherFromElements_(target.WeatherElement || []);
    }
  } catch (e) { byDate = {}; } // 查不到就當作沒有天氣資料，不讓 /api/week、/api/month 掛掉
  if (env.TODOS_KV) {
    // KV put 失敗不能讓 /api/week、/api/month 整個掛掉，byDate 已經算好了，照樣回傳。
    try {
      await env.TODOS_KV.put('weather:forecast', JSON.stringify({ fetchedAt: Date.now(), byDate }), { expirationTtl: 3 * 3600 });
    } catch (e) {
      console.warn('weather:forecast 寫入KV失敗（不影響這次回應）', e && e.message || e);
    }
  }
  return byDate;
}

// 氣象署回傳的是逐 12 小時（白天 06-18、晚上 18-06）資料，A5/A6 的格子是「一天一個」，這裡把
// 同一個西曆日期（取 StartTime 的日期部分）的日/夜兩段合併成一天的摘要：降雨機率取較高者（保守，
// 當天任一時段有風險就標出來）、溫度取當天兩段的最高/最低，天氣描述優先採白天那段（業務實際跑
// 外勤是白天 13:30~17:30，晚上那段參考價值較低）。純函式，不呼叫任何外部資源，方便之後測試。
function buildDailyWeatherFromElements_(weatherElements) {
  function timesOf(name) {
    const el = weatherElements.find(e => e.ElementName === name);
    return el ? (el.Time || []) : [];
  }
  function valueOf(t, field) {
    const ev = t.ElementValue;
    return ev && ev[0] ? ev[0][field] : undefined;
  }
  function dateKeyOf(iso) { return String(iso || '').slice(0, 10); }
  function isDaytime(iso) { return /T06:00:00/.test(iso || ''); }

  const byDate = {};
  function ensure(dateKey) {
    return (byDate[dateKey] = byDate[dateKey] || { maxTemp: null, minTemp: null, pop: null, description: null });
  }
  timesOf('最高溫度').forEach(t => {
    const v = parseFloat(valueOf(t, 'MaxTemperature'));
    if (isNaN(v)) return;
    const d = ensure(dateKeyOf(t.StartTime));
    if (d.maxTemp === null || v > d.maxTemp) d.maxTemp = v;
  });
  timesOf('最低溫度').forEach(t => {
    const v = parseFloat(valueOf(t, 'MinTemperature'));
    if (isNaN(v)) return;
    const d = ensure(dateKeyOf(t.StartTime));
    if (d.minTemp === null || v < d.minTemp) d.minTemp = v;
  });
  // 2026-11-03 實測確認：這個元素雖然 Time 陣列有完整7天14段，但第4~7天的值氣象署直接給字串
  // "-"（代表還沒有精細降雨預報，不是欄位名稱錯或解析漏掉——文件原文「12小時降雨機率(3天內)」
  // 講的就是這件事，PDF 另外提到的「逐日 24小時降雨機率」同樣寫「(3天內)」，這個產品本來就只有
  // 精細降雨機率預報到3天，不是CWA哪個API欄位有更完整資料被我漏接）。parseFloat("-") 自然是
  // NaN，維持原樣跳過即可，pop 停留 null，前端顯示「尚無預報」而不是硬湊一個數字出來。
  timesOf('12小時降雨機率').forEach(t => {
    const v = parseFloat(valueOf(t, 'ProbabilityOfPrecipitation'));
    if (isNaN(v)) return;
    const d = ensure(dateKeyOf(t.StartTime));
    if (d.pop === null || v > d.pop) d.pop = v;
  });
  timesOf('天氣預報綜合描述').forEach(t => {
    const v = valueOf(t, 'WeatherDescription');
    if (!v) return;
    const d = ensure(dateKeyOf(t.StartTime));
    if (!d.description || isDaytime(t.StartTime)) d.description = v;
  });
  return byDate;
}

// GET /api/week?start=YYYY-MM-DD：start 為週一日期，回傳未來 7 天的「跑哪區/已確定路線/日曆事件」
// ＋「這週要做的」（還沒指定日期的請款／有期限的待追蹤／逾期沒去的店）。
// 7 天的 region/hasRoute 是原生 KV 讀取（便宜，不跑評分邏輯）；billingDue/overdueCustomers 靠
// buildCustomerOverview_ 只算一次（不是 7 天各算一次），因為這兩者是「現在」的狀態，不是逐日變化的東西。
async function handleWeekOverview(request, env, ctx) {
  const url = new URL(request.url);
  const startParam = url.searchParams.get('start');
  if (!startParam) return json({ error: '缺少 start' }, 400);
  const startDate = new Date(startParam);
  if (isNaN(startDate)) return json({ error: 'start 格式不對，要 YYYY-MM-DD' }, 400);

  const dateKeys = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(startDate);
    d.setDate(d.getDate() + i);
    dateKeys.push(d.toISOString().slice(0, 10));
  }

  const now = new Date();
  // Plan C：同 handlePlannerPlan，收集 cachedAt（日曆/天氣故意不算進來——它們本來就設計成
  // 1小時/3小時的長效快取，算進「最舊資料時間」只會讓顯示看起來比實際更舊，誤導使用者）。
  const cacheMeta = { oldest: Infinity };
  const [pharmaciesRes, visitsRes, orderData, returnOrderData, contractData, followupRows, ruleRows, calendarEvents, weatherByDate] = await Promise.all([
    handleGetPharmacies(null, env, ctx, cacheMeta).then(r => r.json()),
    handleVisitsSummary(env, ctx, cacheMeta).then(r => r.json()),
    env.SHEET_ORDER_MASTER ? fetchOrderMasterRows(env, ctx, cacheMeta) : Promise.resolve({ rows: [], colMap: {} }),
    fetchGvizSheet(env.SHEET_RETURN_ORDER, null, env, ctx, cacheMeta),
    env.SHEET_CONTRACT
      ? fetchGvizSheet(env.SHEET_CONTRACT, '客戶合約', env, ctx, cacheMeta).catch(() => ({ rows: [], colMap: {}, fetchError: true }))
      : Promise.resolve({ rows: [], colMap: {} }),
    env.SHEET_PLANNER ? fetchGvizRows(env.SHEET_PLANNER, '待追蹤', env, ctx, cacheMeta) : Promise.resolve([]),
    env.SHEET_PLANNER ? fetchGvizRows(env.SHEET_PLANNER, '店家規則', env, ctx, cacheMeta) : Promise.resolve([]),
    fetchGoogleCalendarEvents_(env).catch(() => []),
    fetchWeatherForecast_(env).catch(() => ({})),
  ]);

  const allPharmacies = pharmaciesRes.pharmacies || [];
  const visitMap = visitsRes.summary || {};
  const eligible = allPharmacies.filter(isEligibleForTiering_);
  const statsById = buildOrderStatsById_(orderData.rows, orderData.colMap, returnOrderData.rows, returnOrderData.colMap, eligible, now);
  const p70AvgMonthly = avgMonthlyPercentile_(statsById, 0.70);
  const medianAvgMonthly = avgMonthlyPercentile_(statsById, 0.50);

  // 跟 handlePlannerPlan 同一套寄賣/合約邏輯（只是這裡不分規劃日，用「現在」一次算，見 SPEC 4.5），
  // 2026-11-02 併成共用函式 buildConsignmentByStore_，順便修好「C014 有自己請款規則卻被通用7個月
  // 規則誤判」的 bug（見該函式註解）。
  const eligibleIds = new Set(eligible.map(p => p.id));
  const consignmentByStore = buildConsignmentByStore_(orderData.rows, orderData.colMap, eligibleIds, ruleRows, now);
  const contractByStore = {};
  contractData.rows.forEach(row => {
    const id = String(row.c[contractData.colMap['Customer_ID']]?.v || '').trim();
    if (!id) return;
    const status = String(row.c[contractData.colMap['合約狀態']]?.v || '').trim();
    if (status === '終止') return;
    const amount = parseFloat(row.c[contractData.colMap['切口金額']]?.v || 0) || 0;
    contractByStore[id] = amount;
  });

  const overview = buildCustomerOverview_(eligible, statsById, p70AvgMonthly, medianAvgMonthly, ruleRows, visitMap, followupRows, contractByStore, consignmentByStore, now);

  // 逾期沒去的店（ratio>=1）：保留全部，已經有「拜訪：」未完成待追蹤的附上 scheduledDate，前端顯示
  // 「已排 M/D」徽章而不是移除——使用者 2026-11-02 要求跟請款不同，逾期店要留著當參考，只是標示狀態。
  // 依倍數由高到低排序（2026-11-02 使用者要求：最逾期的排最前面）。
  const overdueCustomers = overview
    .filter(c => c.ratio >= 1)
    .map(c => {
      const scheduled = findActiveFollowupByPrefix_(followupRows, c.id, '拜訪：');
      return {
        id: c.id, name: c.name, ratio: c.ratio, tier: c.tier, avgMonthly: c.avgMonthly,
        region: (regionGroupOf_(c.city, c.district) || {}).key || 'other',
        scheduledDate: scheduled ? scheduled.deadline : null,
        scheduledFollowupId: scheduled ? scheduled.followupId : null,
      };
    })
    .sort((a, b) => b.ratio - a.ratio);

  // 請款待收：banner 永遠是真實合計（不管有沒有已經轉成待追蹤），「還沒指定日期的請款」清單排除
  // 已經有「請款」相關未完成待追蹤的店（findActiveBillingFollowup_ 用包含比對，不是嚴格比對
  // 「請款：」開頭，2026-11-02 松江健保案例修正，見該函式註解），避免同一筆錢在清單上重複出現。
  const billingTriggered = overview.filter(c =>
    c.isContracted ? c.consignmentAllTotal >= c.contractAmount * PLANNER_CONFIG.consignmentReconcileMultiplier : c.consignmentStaleCount > 0
  );
  const billingBanner = {
    count: billingTriggered.length,
    amount: billingTriggered.reduce((s, c) => s + c.consignmentAllTotal, 0),
  };
  // 這裡要帶齊 consignmentBadge()（planner-shared.js／planner.html 共用的門檻判斷）用到的全部欄位，
  // 不是只挑看起來會用到的幾個——沒合約分支的 detail 文字一定會算 consignmentStaleTotal.toLocaleString()，
  // 漏了這欄位會讓整張卡片的渲染直接丟例外（2026-11-02 weekly.html 實測踩到，修正記錄見 CLAUDE.md）。
  const billingDue = billingTriggered
    .filter(c => !findActiveBillingFollowup_(followupRows, c.id))
    .map(c => ({
      id: c.id, name: c.name, isContracted: c.isContracted, contractAmount: c.contractAmount,
      consignmentAllTotal: c.consignmentAllTotal, consignmentStaleCount: c.consignmentStaleCount,
      consignmentStaleMaxMonths: c.consignmentStaleMaxMonths, consignmentStaleTotal: c.consignmentStaleTotal,
    }))
    // 依寄賣月數由久到近排序（2026-11-02 使用者要求：拖最久的排最前面）；有合約、靠金額觸發、
    // 沒有「月數」概念的店 staleMaxMonths 是 0，排在後面，同月數再用寄賣總額決勝。
    .sort((a, b) => (b.consignmentStaleMaxMonths - a.consignmentStaleMaxMonths) || (b.consignmentAllTotal - a.consignmentAllTotal));

  // 7 天的「跑哪區／已確定路線」：原生讀 plan:{date} KV，不跑 handlePlannerPlan 整套評分（7 天各跑一次
  // 太貴，且這兩個欄位本來就是 handleSaveWeekDay/handleSavePlan 存的現成資料）。
  // 今日清單階段二（2026-11-06）：「已確定路線」標籤跟 hasRoute/savedAt 這套 KV 概念一起退休，
  // 改用「今日行程」表——一次抓整張表（走 fetchGvizRows 的 SWR 快取），7 天份用日期分組，
  // 不是每天各打一次 gviz（那樣 7 天會重複抓同一份東西 7 次）。
  const todayPlanAllRows = (await fetchTodayPlanRows_(env, ctx, cacheMeta)).map(todayPlanRowToObj_);
  const todayPlanByDate_ = {};
  todayPlanAllRows.forEach(r => { (todayPlanByDate_[r.date] = todayPlanByDate_[r.date] || []).push(r); });

  const days = await Promise.all(dateKeys.map(async dateKey => {
    const saved = env.TODOS_KV ? await env.TODOS_KV.get(`plan:${dateKey}`, 'json') : null;
    const dayRows = (todayPlanByDate_[dateKey] || [])
      .filter(r => r.status !== '移除')
      .sort((a, b) => (parseInt(a.seq) || 0) - (parseInt(b.seq) || 0));
    return {
      date: dateKey,
      region: saved?.region || null,
      todayPlan: {
        rows: dayRows.map(r => ({ seq: r.seq, name: r.name, storeId: r.storeId })),
        confirmed: dayRows.some(r => r.confirmed),
        // 近似值，不是精確到家時間，見 approxFinishTimeFromRows_ 註解
        finishTime: approxFinishTimeFromRows_(dayRows),
      },
      calendarEvents: calendarEvents.filter(e => e.date === dateKey),
      weather: weatherByDate[dateKey] || null, // 超出氣象署7天範圍時是 null，前端不顯示天氣小卡
    };
  }));

  return json({
    ok: true,
    start: dateKeys[0],
    days,
    billingBanner,
    billingDue,
    overdueCustomers,
    cachedAt: cacheMetaCachedAt_(cacheMeta),
    note: 'billingBanner 是真實合計；billingDue／overdueCustomers 的「已排」判斷靠事項文字開頭' +
      '「請款：」／「拜訪：」比對未完成待追蹤，跟 /api/plan 共用 buildCustomerOverview_ 保證倍數/寄賣數字一致。',
  });
}

// ============================================================
// A7 客戶總覽（SPEC 5.8，2026-11-02）：純讀取彙總，格子資料，沒有寫入。
// ============================================================

// 正式客戶的倍數/分級跟 /api/plan、/api/week 共用 buildCustomerOverview_（故意傳空的
// ruleRows/followupRows/contractByStore/consignmentByStore——A7 只要畫格子，不需要規則狀態/
// 待追蹤倍率/寄賣提醒這些，傳空值不影響 ratio/tier/city/district 的計算，保證 A7 看到的倍數
// 跟 A1/A5 永遠是同一套算法，不會自己兜一份另外的版本出來）。
async function handleOverview(env, ctx) {
  const now = new Date();
  const todayStr = formatDateIso_(now);

  const [pharmaciesRes, visitsRes, orderData, returnOrderData, screeningRows, stageHistoryRows, savedToday] = await Promise.all([
    handleGetPharmacies(null, env, ctx).then(r => r.json()),
    handleVisitsSummary(env, ctx).then(r => r.json()),
    env.SHEET_ORDER_MASTER ? fetchOrderMasterRows(env, ctx) : Promise.resolve({ rows: [], colMap: {} }),
    fetchGvizSheet(env.SHEET_RETURN_ORDER, null, env, ctx),
    env.SCREENING_API_TOKEN
      ? fetchScreeningRows_(env, ctx)
      : Promise.resolve([]),
    env.SHEET_PLANNER ? fetchGvizRows(env.SHEET_PLANNER, '階段歷程', env, ctx) : Promise.resolve([]),
    env.TODOS_KV ? env.TODOS_KV.get(`plan:${todayStr}`, 'json') : Promise.resolve(null),
  ]);

  const allPharmacies = pharmaciesRes.pharmacies || [];
  const eligible = allPharmacies.filter(isEligibleForTiering_);
  const visitMap = visitsRes.summary || {};
  const statsById = buildOrderStatsById_(orderData.rows, orderData.colMap, returnOrderData.rows, returnOrderData.colMap, eligible, now);
  const p70AvgMonthly = avgMonthlyPercentile_(statsById, 0.70);
  const medianAvgMonthly = avgMonthlyPercentile_(statsById, 0.50);
  const customerOverview = buildCustomerOverview_(eligible, statsById, p70AvgMonthly, medianAvgMonthly, [], visitMap, [], {}, {}, now);

  // 「今天已排進路線」：2026-11-02 跟使用者確認過（Q5）——用真正的今天，跟其他規劃層頁面共用的
  // 可調整「規劃日」無關，A7 是客戶層頁面，不吃 ?date= 參數。
  const onRouteIds = new Set((savedToday?.route || []).map(s => s.id));

  // 頂部漏斗：只算正式客戶 4 個分級（2026-11-02 跟使用者確認過，Q4），不含開發中階段——那是
  // A10 已經有的另一個漏斗，這裡重複會讓兩頁資訊重疊。順序照 SPEC 4.5 表格原文。
  const tierOrder = ['大咖', '潛力新店', '冷淡', '一般'];
  const top = tierOrder.map(tier => {
    const inTier = customerOverview.filter(c => c.tier === tier);
    return {
      tier, intervalDays: PLANNER_CONFIG.tierIntervalDays[tier],
      count: inTier.length, overCount: inTier.filter(c => c.ratio >= 1).length,
    };
  });

  // 開發中的店：跟 /api/funnel/overview 的 cards 同一套算法（故意複製一份，不是抽共用函式——
  // 這個檔案裡 /api/plan、/api/funnel/overview 也是各自獨立算一次，同一慣例），只是這裡不分欄、
  // 攤平成跟正式客戶同一種格子資料，給區域分組用。
  const possiblyConvertedIds = possiblyConvertedScreeningIds_(screeningRows, allPharmacies);
  const latestHistoryDate = latestStageHistoryDateByStore_(stageHistoryRows);
  const devStages = ['發現', '初訪後', '二訪後'];
  const developing = screeningRows
    .filter(r => r.decision === '要去' && devStages.indexOf(r.stage) >= 0 && !possiblyConvertedIds.has(r.id))
    .map(r => {
      const effectiveDate = latestHistoryDate[r.id] || r.stageDate;
      const interval = PLANNER_CONFIG.stageIntervalDays[r.stage] || null;
      const daysSince = effectiveDate ? daysBetween(effectiveDate, now) : null;
      const ratio = (daysSince !== null && interval) ? Math.round((daysSince / interval) * 100) / 100 : null;
      return {
        id: r.id, name: r.name, type: 'new-store', stage: r.stage,
        city: r.city, district: r.district,
        ratio, ratioTier: ratio === null ? null : ratioTierOf(ratio),
        isOnTodayRoute: onRouteIds.has(r.id),
      };
    });

  const customerCells = customerOverview.map(c => ({
    id: c.id, name: c.name, type: 'customer', tier: c.tier,
    city: c.city, district: c.district,
    ratio: c.ratio, ratioTier: ratioTierOf(c.ratio),
    isOnTodayRoute: onRouteIds.has(c.id),
  }));

  // 區域分組：帳單 7 分類（regionGroupOf_，跟 A1「今天可以跑的區」同一套），不是依城市分組——
  // 2026-11-02 跟使用者確認過的既定決定，取代 SPEC 5.8 原文字面上寫的「依城市分組」。
  const byGroupKey = {};
  PLANNER_CONFIG.regionGroups.forEach(g => { byGroupKey[g.key] = { key: g.key, label: g.label, stores: [] }; });
  const fallback = { key: 'other', label: PLANNER_CONFIG.regionFallbackLabel, stores: [] };
  function bucketOf(city, district) {
    const g = regionGroupOf_(city, district);
    return g ? byGroupKey[g.key] : fallback;
  }
  [...customerCells, ...developing].forEach(cell => { bucketOf(cell.city, cell.district).stores.push(cell); });
  const regions = PLANNER_CONFIG.regionGroups.map(g => byGroupKey[g.key]).filter(r => r.stores.length);
  if (fallback.stores.length) regions.push(fallback);
  regions.forEach(r => r.stores.sort((a, b) => (b.ratio ?? 0) - (a.ratio ?? 0))); // 倍數高到低，比較急的店排前面

  return json({
    ok: true,
    top,
    regions,
    excludedCount: {
      total: allPharmacies.length, afterExclude: eligible.length,
      dead: allPharmacies.filter(p => p.deadReason).length,
      dad: allPharmacies.filter(p => p.owner === '老爸').length,
      hsinchu: allPharmacies.filter(p => PLANNER_CONFIG.excludedCities.indexOf(p.city) >= 0).length,
      noVisit: allPharmacies.filter(p => p.status === '不拜訪').length,
    },
    note: '正式客戶倍數/分級跟 /api/plan、/api/week 共用 buildCustomerOverview_；開發中店倍數跟 ' +
      '/api/funnel/overview 同一套階段公式；區域分組用帳單7分類（regionGroupOf_），不是依城市；' +
      '排除名單（死客戶/老爸/新竹/不拜訪）完全不顯示；「今天已排」用真正今天的日期，不吃 ?date= 參數。',
  });
}

// ============================================================
// A6 本月（SPEC 5.7，2026-11-02）：月曆格資料＋本月累計統計，純讀取，沒有寫入端點。
// 假日/週末標示交給前端自己讀 holidays-{year}.json 疊加（跟 weekly.html 同一個模式，見
// planner-shared.js loadHolidays()），這支只處理拜訪量/預計區域/週期色帶/累計數字。
// ============================================================

function formatYearMonth_(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; }

// 2026-11-02 跟使用者確認過（Q8）：只能查「上個月／本月／下個月」，不開放任意回溯——
// handleAllVisits() 只回傳最近 500 筆拜訪紀錄，範圍再放寬可能漏算，「本月累計」等統計會不準。
function monthRangeOk_(requested, today) {
  const base = new Date(today.getFullYear(), today.getMonth(), 1);
  const prev = new Date(base); prev.setMonth(prev.getMonth() - 1);
  const next = new Date(base); next.setMonth(next.getMonth() + 1);
  return [formatYearMonth_(prev), formatYearMonth_(base), formatYearMonth_(next)].indexOf(requested) >= 0;
}

// 待追蹤表「建立日期」／「完成日期」有時是 gviz 原始字面值 Date(y,m,d)、有時是純文字日期，
// parseGvizDate() 兩種都處理，但它不會補零（January 可能回 "2026/1/5"）——直接 slice 字串
// 抓年月在單位數月份會抓錯，這裡改用真正的 Date 物件算年月，不管原始格式有沒有補零都準。
function monthKeyOfRaw_(rawDateStr) {
  const parsed = parseGvizDate(rawDateStr);
  if (!parsed) return null;
  const d = new Date(String(parsed).replace(/\//g, '-'));
  if (isNaN(d)) return null;
  return formatYearMonth_(d);
}

async function handleMonthOverview(request, env, ctx) {
  const url = new URL(request.url);
  const now = new Date();
  const month = url.searchParams.get('month') || formatYearMonth_(now);
  if (!/^\d{4}-\d{2}$/.test(month)) return json({ error: 'month 格式不對，要 YYYY-MM' }, 400);
  if (!monthRangeOk_(month, now)) return json({ error: '只能查詢上個月／本月／下個月' }, 400);

  const [year, monthNum] = month.split('-').map(Number);
  const monthIndex = monthNum - 1;
  const firstOfMonth = new Date(year, monthIndex, 1);
  const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();
  const prevMonthDate = new Date(year, monthIndex - 1, 1);
  const nextMonthDate = new Date(year, monthIndex + 1, 1);
  const prevMonthKey = formatYearMonth_(prevMonthDate);
  const nextMonthKey = formatYearMonth_(nextMonthDate);

  const [pharmaciesRes, visitsRes, followupRows, weatherByDate, todayPlanRowsAll] = await Promise.all([
    handleGetPharmacies(null, env, ctx).then(r => r.json()),
    handleAllVisits(env).then(r => r.json()),
    env.SHEET_PLANNER ? fetchGvizRows(env.SHEET_PLANNER, '待追蹤', env, ctx) : Promise.resolve([]),
    fetchWeatherForecast_(env).catch(() => ({})),
    fetchTodayPlanRows_(env, ctx),
  ]);
  // 今日清單階段二（2026-11-06）：未來天的家數改從「今日行程」表算，不是只顯示「預計區域」文字
  // ——一次抓整張表分組，不是每天各打一次 gviz。
  const todayPlanByDate2_ = {};
  todayPlanRowsAll.map(todayPlanRowToObj_).forEach(r => {
    if (r.status === '移除') return;
    (todayPlanByDate2_[r.date] = todayPlanByDate2_[r.date] || []).push(r);
  });

  const allPharmacies = pharmaciesRes.pharmacies || [];
  const eligible = allPharmacies.filter(isEligibleForTiering_);
  const eligibleIds = new Set(eligible.map(p => p.id));

  // handleAllVisits() 的 date 欄位是 "YYYY/M/D"（月/日不補零），轉成 "YYYY-MM-DD" 當分組 key。
  function visitDateToIso_(s) {
    const m = String(s).match(/^(\d+)\/(\d+)\/(\d+)$/);
    if (!m) return null;
    return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
  }
  const visits = visitsRes.visits || [];
  const visitsByDate = {};
  const monthVisits = [];
  visits.forEach(v => {
    const iso = visitDateToIso_(v.date);
    if (!iso) return;
    (visitsByDate[iso] = visitsByDate[iso] || []).push(v);
    if (iso.slice(0, 7) === month) monthVisits.push(v);
  });

  const todayIso = formatDateIso_(now);
  const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const mondayIndexOf_ = jsDay => (jsDay + 6) % 7; // 週一=0…週日=6，月曆格一律週一開頭
  const leadingPad = mondayIndexOf_(firstOfMonth.getDay());
  const trailingPad = (7 - ((leadingPad + daysInMonth) % 7)) % 7;

  const days = [];
  for (let i = leadingPad; i > 0; i--) {
    const d = new Date(year, monthIndex, 1 - i);
    days.push({ date: formatDateIso_(d), inMonth: false });
  }
  for (let dayNum = 1; dayNum <= daysInMonth; dayNum++) {
    const date = new Date(year, monthIndex, dayNum);
    const iso = formatDateIso_(date);
    const isToday = iso === todayIso;
    const isPast = date < todayMidnight;
    const visitCount = (visitsByDate[iso] || []).length;
    const loadTier = (isPast || isToday)
      ? (visitCount >= 7 ? 'high' : visitCount >= 4 ? 'mid' : visitCount >= 1 ? 'low' : null)
      : null;
    // 降雨提醒（SPEC 5.7「未來日子顯示預計區域與降雨提醒」）：只給未來天，60% 以上才標記，
    // 跟 A5 同一個門檻（SPEC 4.4 以外的另一組門檻，使用者原文就是「60%以上標紅」）。氣象署資料
    // 只涵蓋未來約7天，超出範圍 weatherByDate 查無資料，rainWarning 自然是 false，前端不顯示。
    const weather = (!isPast && !isToday) ? (weatherByDate[iso] || null) : null;
    // 未來天的計畫家數：今日行程表那天的可見列數（已經排除「移除」）；過去/今天用 visitCount
    // （實際拜訪紀錄）才對，今日行程是計畫不是事實，兩者故意不混用。
    const plannedCount = (!isPast && !isToday) ? (todayPlanByDate2_[iso] || []).length : null;
    days.push({
      date: iso, inMonth: true, isToday, isPast, visitCount, loadTier,
      mailingBand: dayNum >= 1 && dayNum <= 5,   // 寄單期，跟 weekly.html 同一套規則（SPEC/CLAUDE.md）
      billingBand: dayNum >= 25 && dayNum <= 30, // 請款期，個別店家例外走「店家規則」，這裡不特殊處理
      region: null, // 只有未來天才補（見下面），過去/今天不需要
      plannedCount,
      weather,
      rainWarning: !!(weather && weather.pop !== null && weather.pop >= 60),
    });
  }
  for (let i = 1; i <= trailingPad; i++) {
    const d = new Date(year, monthIndex, daysInMonth + i);
    days.push({ date: formatDateIso_(d), inMonth: false });
  }

  // 未來天的「預計區域」：讀 plan:{date} KV 的 region 欄位（跟 /api/week 同一個 key，原生讀取，
  // 不跑整套評分），過去/今天不用補這個欄位。
  if (env.TODOS_KV) {
    await Promise.all(days.filter(d => d.inMonth && !d.isPast && !d.isToday).map(async d => {
      const saved = await env.TODOS_KV.get(`plan:${d.date}`, 'json');
      d.region = saved?.region || null;
    }));
  }

  // 本月累計（2026-11-02 跟使用者確認過，Q9/Q10）：統計範圍是目前查詢的月份（跟月曆格對齊，
  // 不是固定今天所在的月份——切去上個月看，累計數字也跟著切，畫面才不會互相矛盾）。
  const coveredIds = new Set(monthVisits.map(v => v.pharmacyId).filter(id => eligibleIds.has(id)));
  const newDevVisitCount = monthVisits.filter(v => v.purpose === '新客開發').length;
  const notVisitedCustomerCount = eligible.length - coveredIds.size;

  // 請款進度（Q9 保守做法）：數「待追蹤」表事項文字以「請款：」開頭的，依「完成日期」(已完成)
  // 或「建立日期」(未完成) 落在這個月份，分「已完成」/「未完成」兩類數量——跟 A5 的
  // billingDue/billingBanner（即時判斷「現在該不該整理寄賣」）是不同的統計目的，這裡單純數
  // 這個月有多少請款待追蹤被建立/處理掉，資料來源一樣是「待追蹤」分頁，不是舊版 /invoice-tasks。
  let billingDone = 0, billingPending = 0;
  followupRows.forEach(f => {
    const item = f.get('事項') || '';
    if (!item.startsWith('請款：')) return;
    const status = f.get('狀態') || '未完成';
    const refDate = status === '已完成' ? f.get('完成日期') : f.get('建立日期');
    if (monthKeyOfRaw_(refDate) !== month) return;
    if (status === '已完成') billingDone++; else billingPending++;
  });

  return json({
    ok: true,
    month, prevMonth: prevMonthKey, nextMonth: nextMonthKey,
    canGoPrev: monthRangeOk_(prevMonthKey, now), canGoNext: monthRangeOk_(nextMonthKey, now),
    days,
    summary: {
      visitCount: monthVisits.length,
      coveredCustomerCount: coveredIds.size,
      newDevVisitCount,
      notVisitedCustomerCount,
      billing: { done: billingDone, pending: billingPending },
      mailingNote: '寄單流程還沒遷移到「待追蹤」表，暫不顯示進度（跟 CLAUDE.md「A5 本週」一節記錄的現況一致）',
    },
    note: '只能查上個月／本月／下個月（handleAllVisits 只回傳最近500筆，範圍再放寬可能漏算）；' +
      '假日/週末由前端讀 holidays-{year}.json 疊加顯示，跟 weekly.html 同一個模式，這支不處理；' +
      '請款進度數的是「待追蹤」表「請款：」開頭事項在這個月完成/建立的數量，不是 A5 即時寄賣金額判斷；' +
      '「覆蓋客戶數」「還沒去過的客戶數」只算排除規則篩過的名單內的正式客戶（跟 /api/plan 等一致）。',
  });
}

// ============================================================
// Phase 2：A8 藥局檔案抽屜 — 單店全部資料
// 分級/寄賣/簽約那一段直接複用 /api/plan 的同一組函數跟同一套資料來源，保證兩邊看到的數字一致；
// 不是另外寫一套算法。代價是跟 /api/plan 一樣要整批撈訂單/退貨/合約資料，但這是給抽屜用的低頻端點，不是列表。
// ============================================================
async function handleStoreDetail(request, env, ctx) {
  const url = new URL(request.url);
  const id = url.searchParams.get('id');
  if (!id) return json({ error: '缺少 id' }, 400);
  const planDate = new Date();

  const [pharmaciesRes, visitsRes, screeningRows, followupRows, ruleRows, orderData, returnOrderData, contractData] = await Promise.all([
    handleGetPharmacies(null, env, ctx).then(r => r.json()),
    handleVisitsSummary(env, ctx).then(r => r.json()),
    env.SCREENING_API_TOKEN
      ? fetchScreeningRows_(env, ctx)
      : Promise.resolve([]),
    env.SHEET_PLANNER ? fetchGvizRows(env.SHEET_PLANNER, '待追蹤', env, ctx) : Promise.resolve([]),
    env.SHEET_PLANNER ? fetchGvizRows(env.SHEET_PLANNER, '店家規則', env, ctx) : Promise.resolve([]),
    env.SHEET_ORDER_MASTER ? fetchOrderMasterRows(env, ctx) : Promise.resolve({ rows: [], colMap: {} }),
    fetchGvizSheet(env.SHEET_RETURN_ORDER, null, env, ctx),
    env.SHEET_CONTRACT
      ? fetchGvizSheet(env.SHEET_CONTRACT, '客戶合約', env, ctx).catch(() => ({ rows: [], colMap: {}, fetchError: true }))
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
      // 2026-11-02：這家店有自己的「請款規則」（例如 C014 來福「隔月5號請款，不走寄賣7個月」）
      // 就不計入 staleXxx——跟 buildConsignmentByStore_（/api/plan、/api/week 共用）同一條件，
      // A8 藥局檔案抽屜這份是第三份複製（單店查詢，結構跟那邊的全店字典不同，沒有直接共用），
      // 但判斷條件要保持一致，不然這裡跟 A1/A5 看到的「該不該整理」會互相矛盾。
      if (monthsSince >= PLANNER_CONFIG.consignmentCleanupMonths && !hasActiveBillingRule_(ruleRows, id)) {
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
    // 2026-11-05：新店（screeningRow）原本 address/city/district 全部回 null——這幾欄客戶表
    // 沒有才對，但篩選分頁本來就有同名欄位（new-pharmacy-screening/apps-script/Code.gs 的
    // FIELD 對照：address/city/district），正式客戶優先，沒有正式客戶資料才退回篩選分頁的值。
    // 篩選分頁沒有電話欄位（COLS 裡沒有「電話」），phone 維持只讀客戶表，新店永遠是 null，
    // 不是漏填，是資料來源真的沒有這欄。
    address: pharmacy ? pharmacy.address : (screeningRow ? screeningRow.address : null),
    city: pharmacy ? pharmacy.city : (screeningRow ? screeningRow.city : null),
    district: pharmacy ? pharmacy.district : (screeningRow ? screeningRow.district : null),
    greeting: pharmacy ? pharmacy.greeting : null,
    phone: pharmacy ? pharmacy.phone : null,
    isDadStore: pharmacy ? pharmacy.owner === '老爸' : false,
    excludeReason,
    tiering,
    monthlyOrders,
    rules: myRules,
    followups: myFollowups,
    // 篩選器裡對拜訪有用的欄位，原始值直接帶過去，「沒有值要不要顯示」交給前端判斷（store-drawer.js
    // 的「篩選資料」區塊）——這裡不先篩，保持 Worker 端單純轉資料，顯示規則別分散兩邊各寫一次。
    screening: screeningRow ? {
      setup: screeningRow.setup || null,         // 設立日期
      front: screeningRow.front,                 // 門前藥局（boolean）
      chain: screeningRow.chain,                 // 連鎖藥局（boolean）
      wrong: screeningRow.wrong,                 // 名單有誤（boolean）
      note: screeningRow.note || null,           // 備註
      stageDate: screeningRow.stageDate || null,  // 進入目前階段的日期
      flags: screeningRow.flags || null,         // 系統提醒（例如換負責人、地址同既有客戶）
    } : null,
  });
}

// 店家規則：新增/修改都轉送 GAS（gas-backend 的 addRule/updateRule action）
// 2026-10-28：addRule/updateRule/deleteRule 這幾個 action GAS 那邊現在要求帶 token，密鑰從
// wrangler secret（env.PLANNER_API_TOKEN）讀，由 Worker 代填——planner.html／store-drawer.js
// 只打這支 Worker 端點，永遠不會看到密鑰，也不會直接打 GAS。`{ ...body, action, token }`
// 故意把 action/token 放在展開之後，就算前端自己塞了同名欄位也會被這裡蓋掉，不是前端說了算。
// ============================================================
// A2 店家規則管理頁：全部店家＋全部規則（含店名），左側清單／右側規則卡只讀這一支就夠
// 2026-10-31：店家清單排除「停用」(死客戶) 跟新竹縣市，但保留「負責人=老爸」的店——老爸的店有固定
// 提醒規則（送貨還帳單、請款交錢），跟 isEligibleForTiering_（評分用，老爸也排除）不是同一條規則，
// 不能直接共用那個函式，這裡另外寫一個比較窄的排除條件（使用者 2026-10-31 明確要求保留老爸）。
// 2026-11-01 補：「不拜訪」特別通路（例：C135政治大學選舉研究中心）優先於「老爸保留」排除——
// 不拜訪的店就算負責人是老爸也不留在 A2；負責人是老爸、但狀態不是不拜訪的店照舊保留。這條判斷
// 跟 isEligibleForTiering_ 共用 isMarkedDoNotVisit_()，不是另外寫一次。
// ============================================================
function visibleForRuleManagement_(p) {
  if (p.deadReason) return false;
  if (isMarkedDoNotVisit_(p)) return false;
  if (PLANNER_CONFIG.excludedCities.indexOf(p.city) >= 0) return false;
  return true;
}

async function handleListPlannerRules(env, ctx) {
  const [pharmaciesRes, ruleRows] = await Promise.all([
    handleGetPharmacies(null, env, ctx).then(r => r.json()),
    env.SHEET_PLANNER ? fetchGvizRows(env.SHEET_PLANNER, '店家規則', env, ctx) : Promise.resolve([]),
  ]);

  const allPharmacies = (pharmaciesRes.pharmacies || []).filter(visibleForRuleManagement_);
  const nameById = {}; allPharmacies.forEach(p => { nameById[p.id] = p.name; });

  const rules = ruleRows
    .filter(r => nameById[r.get('店家代號')]) // 排除掉的店（停用/新竹）連帶不顯示它的規則
    .map(r => ({
      ruleId: r.get('規則ID'), storeId: r.get('店家代號'), storeName: nameById[r.get('店家代號')],
      ruleType: r.get('規則類型'), weekdays: r.get('星期'), monthDays: r.get('每月日期'),
      timeFrom: r.get('時段起'), timeTo: r.get('時段迄'), note: r.get('說明'),
      action: r.get('排程處理'), source: r.get('來源'), status: r.get('狀態') || '有效',
      createdDate: r.get('建立日期') || null,
    }));

  // 「有規則」篩選只算「有效」規則——停用的規則不代表這家店現在真的有規則在影響排程
  const ruleCountByStore = {};
  rules.forEach(r => { if (r.status === '有效') ruleCountByStore[r.storeId] = (ruleCountByStore[r.storeId] || 0) + 1; });

  // 2026-11-01：加 city/district 給 A2 左側清單的「市→區」分組用（store-rules.html），正規化
  // （臺→台）交給前端 planner-shared.js 的 groupStoresByRegion() 做，這裡維持原始欄位值。
  const stores = allPharmacies.map(p => ({ id: p.id, name: p.name, ruleCount: ruleCountByStore[p.id] || 0, city: p.city, district: p.district }));

  return json({ ok: true, stores, rules });
}

// ============================================================
// A3 待追蹤管理頁：全部待追蹤（不分規劃日），含店名解析、距上次接觸、對排程的影響
// 2026-10-31：「對排程的影響」刻意不發明新公式——忠實呈現 handlePlannerPlan 已經在用的兩套既有機制的
// 文字版（使用者確認過方向）：
//   新店開發：scoreFollowups 的逐筆期限分級點數（加總/封頂之前的中間值，不是另一套公式）
//   正式客戶：沒有逐筆分數，只有「整店 ×followupMultiplier」或「已到期，列入今天」兩種狀態文字
// ============================================================
function resolveFollowupStore_(storeId, pharmacyById, screeningById) {
  const p = pharmacyById[storeId];
  if (p) return { storeName: p.name, storeType: 'customer' };
  const s = screeningById[storeId];
  if (s) return { storeName: s.name, storeType: 'new-store' };
  return { storeName: storeId, storeType: 'unknown' };
}

function followupImpactText_(storeType, deadlineType, deadline, now) {
  if (storeType === 'new-store') {
    if ((deadlineType || '下次經過') === '下次經過') {
      return `+${PLANNER_CONFIG.followupScore.nextVisit}（下次經過）`;
    }
    const daysUntil = deadline ? -daysBetween(deadline, now) : null;
    if (daysUntil === null) return `+${PLANNER_CONFIG.followupScore.dueLater}（期限缺資料）`;
    if (daysUntil <= 3) return `+${PLANNER_CONFIG.followupScore.dueWithin3Days}（剩${daysUntil}天${daysUntil < 0 ? '，已逾期' : ''}）`;
    if (daysUntil <= 7) return `+${PLANNER_CONFIG.followupScore.dueWithin7Days}（剩${daysUntil}天）`;
    return `+${PLANNER_CONFIG.followupScore.dueLater}（剩${daysUntil}天）`;
  }
  // 正式客戶（含找不到店家類型時一併保守用這套）：沒有逐筆分數，只有到期/未到期兩種狀態
  if ((deadlineType || '下次經過') === '指定日期前' && deadline) {
    const daysUntil = -daysBetween(deadline, now);
    if (daysUntil <= 0) return '已到期，列入今天';
  }
  return `整店 ×${PLANNER_CONFIG.followupMultiplier}`;
}

async function handleListPlannerFollowups(env, ctx) {
  const now = new Date();
  const cacheMeta = { oldest: Infinity };
  const [pharmaciesRes, visitsRes, screeningRows, followupRows, orderData, returnOrderData] = await Promise.all([
    handleGetPharmacies(null, env, ctx, cacheMeta).then(r => r.json()),
    handleVisitsSummary(env, ctx, cacheMeta).then(r => r.json()),
    env.SCREENING_API_TOKEN
      ? fetchScreeningRows_(env, ctx, cacheMeta)
      : Promise.resolve([]),
    env.SHEET_PLANNER ? fetchGvizRows(env.SHEET_PLANNER, '待追蹤', env, ctx, cacheMeta) : Promise.resolve([]),
    env.SHEET_ORDER_MASTER ? fetchOrderMasterRows(env, ctx, cacheMeta) : Promise.resolve({ rows: [], colMap: {} }),
    fetchGvizSheet(env.SHEET_RETURN_ORDER, null, env, ctx, cacheMeta),
  ]);

  const allPharmacies = pharmaciesRes.pharmacies || [];
  const pharmacyById = {}; allPharmacies.forEach(p => { pharmacyById[p.id] = p; });
  const screeningById = {}; screeningRows.forEach(r => { screeningById[r.id] = r; });
  const visitMap = visitsRes.summary || {};

  // 「距上次接觸」要適用所有有待追蹤的店，不只 isEligibleForTiering_ 篩過的子集——
  // 老爸/新竹/死客戶/不拜訪的店一樣可能掛著待追蹤事項，所以這裡傳全部客戶去建統計，不是 eligible 子集。
  const statsById = buildOrderStatsById_(orderData.rows, orderData.colMap, returnOrderData.rows, returnOrderData.colMap, allPharmacies, now);

  const followups = followupRows.map(f => {
    const storeId = f.get('店家代號');
    const { storeName, storeType } = resolveFollowupStore_(storeId, pharmacyById, screeningById);
    const status = f.get('狀態') || '未完成';
    const deadlineType = f.get('期限類型') || '下次經過';
    const deadline = f.get('期限') || null;
    const visitDate = (visitMap[storeId] || {}).lastDate || '';
    const orderDate = (statsById[storeId] && statsById[storeId].hasOrders) ? statsById[storeId].lastOrderDate : '';
    const lastContactDate = laterDateOrNull_(visitDate, orderDate);
    return {
      followupId: f.get('待追蹤ID'), storeId, storeName, storeType,
      item: f.get('事項'), who: f.get('誰交代') || '我',
      deadlineType, deadline,
      createdDate: f.get('建立日期') || null,
      status,
      resolvedDate: f.get('完成日期') || null,
      resolvedFrom: f.get('完成來源') || null,
      lastContactDate: lastContactDate || null,
      daysSinceLastContact: lastContactDate ? daysBetween(lastContactDate, now) : null,
      impact: status === '未完成' ? followupImpactText_(storeType, deadlineType, deadline, now) : '—',
    };
  });

  // 隨手新增的店名搜尋清單：正式客戶全部（含老爸/新竹/不拜訪，跟 A1 手動加入同一個精神——
  // 管理頁不該讓這些店連「加一筆待追蹤」都做不到）＋開發中的新店（階段不是「放棄」「轉正式」的）。
  const addableStores = [
    ...allPharmacies.map(p => ({ id: p.id, name: p.name, type: 'customer' })),
    ...screeningRows.filter(r => r.stage && r.stage !== '放棄' && r.stage !== '轉正式')
      .map(r => ({ id: r.id, name: r.name, type: 'new-store' })),
  ];

  return json({
    ok: true,
    followups,
    addableStores,
    badges: { followupsDueSoon: computeFollowupsDueSoonBadge_(followupRows) },
    cachedAt: cacheMetaCachedAt_(cacheMeta),
  });
}

async function handlePlannerRules(request, env) {
  const body = await request.json();
  const action = body.delete ? 'deleteRule' : (body.ruleId ? 'updateRule' : 'addRule');
  const res = await fetch(env.GAS_VISIT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, action, token: env.PLANNER_API_TOKEN }),
    redirect: 'follow',
  });
  const data = await res.json();
  // 寫成功才清「店家規則」的 gviz 快取（2026-11-03 加的 TTL 60秒讀取快取，見 fetchGvizRows），
  // 不然使用者剛改完規則，60秒內還會看到舊的。
  if (data.success) await invalidateGvizCache_(env, env.SHEET_PLANNER, '店家規則');
  return json({ ok: !!data.success, ...data });
}

// 待追蹤：新增/結案/刪除/修改都轉送 GAS（gas-backend 的 addFollowup/resolveFollowup/deleteFollowup/
// updateFollowup action），token 代填的理由同上。
// 2026-10-31：A3「編輯」用明確的 body.action === 'update'（不是用 followupId 存在與否去推斷，
// 跟 handlePlannerRules 的 ruleId 推斷寫法不一樣——使用者要求這裡要明確，避免未來改欄位時推斷邏輯誤判）。
async function handlePlannerFollowups(request, env, ctx) {
  const body = await request.json();
  const action = body.delete ? 'deleteFollowup'
    : body.resolve ? 'resolveFollowup'
    : body.action === 'update' ? 'updateFollowup'
    : 'addFollowup';
  const res = await fetch(env.GAS_VISIT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, action, token: env.PLANNER_API_TOKEN }),
    redirect: 'follow',
  });
  const data = await res.json();
  // 寫成功才清「待追蹤」的 gviz 快取（同上，weekly.html 拖放指派到某天之後會立刻重新 GET
  // /api/followups，不清快取會讓使用者以為拖放沒生效）。
  if (data.success) await invalidateGvizCache_(env, env.SHEET_PLANNER, '待追蹤');

  // 2026-11-04：gas-backend 的 addFollowup 偵測到「同店同事項已有未完成待追蹤」時（3e98a30）
  // 只回傳既有那一筆的 followupId（duplicate:true），這次請求帶的 deadline/deadlineType/who
  // 整個被忽略——如果使用者其實是想改期限/改負責人（不是單純連點造成的重複），畫面會跟平常新增
  // 成功顯示一樣的提示，但設定完全沒套用，使用者不會發現。這裡補一層：讀出既有那一筆目前的
  // deadline/deadlineType/who，跟這次請求的值比對，不同就代呼叫 updateFollowup 把既有那一筆改成
  // 這次的值，再把前後差異回傳給前端，讓前端能分「已改期限」／「設定沒變，沒有重複新增」兩種情況
  // 分別提示（見 followups.html/weekly.html/funnel.html 的 handleFollowupDedupToast_）。
  // GAS 本身不用改——這是比對/決定要不要補一次 updateFollowup 呼叫的邏輯，放在 Worker 這一層。
  if (action === 'addFollowup' && data.success && data.duplicate && data.followupId) {
    const followupRows = await fetchGvizRows(env.SHEET_PLANNER, '待追蹤', env, ctx, { oldest: Infinity });
    const existing = followupRows.find(f => f.get('待追蹤ID') === data.followupId);
    const previousDeadlineType = existing ? (existing.get('期限類型') || '下次經過') : '下次經過';
    const previousDeadline = existing ? (existing.get('期限') || '') : '';
    const previousWho = existing ? (existing.get('誰交代') || '我') : '我';

    const patch = {};
    if (body.deadlineType !== undefined && body.deadlineType !== previousDeadlineType) patch.deadlineType = body.deadlineType;
    if (body.deadline !== undefined && (body.deadline || '') !== (previousDeadline || '')) patch.deadline = body.deadline;
    if (body.who && body.who !== previousWho) patch.who = body.who;

    let updated = false;
    if (Object.keys(patch).length > 0) {
      const updateRes = await fetch(env.GAS_VISIT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'updateFollowup', followupId: data.followupId, patch, token: env.PLANNER_API_TOKEN }),
        redirect: 'follow',
      });
      const updateData = await updateRes.json();
      if (updateData.success) {
        updated = true;
        await invalidateGvizCache_(env, env.SHEET_PLANNER, '待追蹤');
      }
    }

    return json({
      ok: true, success: true, duplicate: true, updated,
      followupId: data.followupId,
      previousDeadlineType, previousDeadline,
      deadlineType: updated && patch.deadlineType !== undefined ? patch.deadlineType : previousDeadlineType,
      deadline: updated && patch.deadline !== undefined ? patch.deadline : previousDeadline,
      previousWho, who: updated && patch.who !== undefined ? patch.who : previousWho,
    });
  }

  return json({ ok: !!data.success, ...data });
}

// ============================================================
// A10 新店開發（SPEC 5.9/3.7）：/api/funnel/overview、/api/funnel/result
// ============================================================

// 篩選分頁這一列的店名如果跟某個正式客戶完全相同，視為已經轉正——當場建檔（pharmacy-visit-app）
// 跟稅籍比對（new-pharmacy-screening）是兩套從不互相通知的建檔路徑，篩選分頁的「目前階段」欄位
// 不會自動變成「轉正式」（見下面 handlePlannerPlan 原本那段註解）。/api/plan 用這份結果直接濾掉
// 這些店（不列進推薦清單），A10 用同一份結果改標「可能已轉正，請確認」讓使用者自己確認後走
// 「確認已建檔」補正式代號——兩邊必須用同一份比對邏輯，不要各寫一次，否則判斷會兜不起來。
function possiblyConvertedScreeningIds_(screeningRows, allPharmacies) {
  const realCustomerNames = new Set(allPharmacies.map(p => String(p.name || '').trim()).filter(Boolean));
  const ids = new Set();
  screeningRows.forEach(r => {
    if (!r.stage || r.stage === '轉正式' || r.stage === '放棄') return;
    if (realCustomerNames.has(String(r.name || '').trim())) ids.add(r.id);
  });
  return ids;
}

// 階段歷程（店代號/日期都是文字欄位）依店代號取最新一筆的日期，給 /api/plan 跟 /api/funnel/overview
// 共用當「倍數起算日」——兩邊都要用同一個函式，不然 A1 跟 A10 看到的同一家店倍數會兜不起來。
// 日期是 yyyy-MM-dd 格式的文字，字串比較就能正確排序，不用轉成 Date 物件。
function latestStageHistoryDateByStore_(stageHistoryRows) {
  const result = {};
  stageHistoryRows.forEach(h => {
    const storeId = h.get('店代號');
    const date = h.get('日期');
    if (!storeId || !date) return;
    if (!result[storeId] || date > result[storeId]) result[storeId] = date;
  });
  return result;
}

// 階段歷程裡「到階段＝轉正式」那筆事件的正式代號，給 A10 看板「轉正式」欄的卡片顯示用。
function convertedCustomerIdByStore_(stageHistoryRows) {
  const result = {};
  stageHistoryRows.forEach(h => {
    if (h.get('到階段') !== '轉正式') return;
    const storeId = h.get('店代號');
    const customerId = h.get('正式代號');
    if (storeId && customerId) result[storeId] = customerId;
  });
  return result;
}

// 篩選分頁（new-pharmacy-screening）清單只是「顯示用」整批讀一次，被 /api/plan、/api/week、
// /api/followups、/api/funnel/overview 四個端點各自讀。改用 swrFetch_()；verifyScreeningStage_()／
// handleFunnelResult() 自己要核對「現在真正的階段」那兩處刻意不走這份快取（仍然直接 fetch），
// 避免寫入流程根據過期資料做決定。
async function fetchScreeningRowsRaw_(env) {
  const data = await fetch(`${env.SCREENING_API_URL}?token=${encodeURIComponent(env.SCREENING_API_TOKEN)}`).then(r => r.json());
  return data.rows || [];
}
async function fetchScreeningRows_(env, ctx, cacheMeta) {
  if (!env.SCREENING_API_TOKEN) return [];
  const entry = await swrFetch_(env, ctx, 'screening:rows', () => fetchScreeningRowsRaw_(env));
  noteCacheTime_(cacheMeta, entry.cachedAt);
  return entry.data;
}

// 呼叫 new-pharmacy-screening 的 doPost 更新篩選分頁階段（stageAction: advance/drop/confirm，
// 伺服器端驗證在 Code.gs，這裡不重複驗證階段順序）。回傳 {ok,stage} 或 {ok:false,error}，
// 不 throw——呼叫端要能分辨「這一步失敗」跟「網路本身出錯」，兩種都要走下面的核對流程。
async function callScreeningStageAction_(storeId, stageAction, dropReason, env) {
  if (!env.SCREENING_API_TOKEN) return { ok: false, error: '缺少 SCREENING_API_TOKEN（wrangler secret 未設定）' };
  try {
    const res = await fetch(env.SCREENING_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: env.SCREENING_API_TOKEN, id: storeId, patch: { stageAction, dropReason } }),
      redirect: 'follow',
    });
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch (e) { data = null; }
    if (data && data.ok) {
      if (env.TODOS_KV) await env.TODOS_KV.delete('screening:rows').catch(() => {});
      return { ok: true, stage: data.stage };
    }
    return { ok: false, error: (data && data.error) || `HTTP ${res.status}（回應內容：${text.slice(0, 200)}）` };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

// 2026-11-02（使用者要求）：篩選分頁那一步「看起來」失敗時，不能直接憑 POST 的回應內容決定要不要
// 把剛寫的階段歷程刪掉——2026-10-31 已經踩過一次「GAS 回應看起來失敗（curl 顯示 411），但伺服器端
// 其實已經執行成功」的坑。這裡用 doGet 重新讀一次那家店目前真正的階段，分三種結果處理：
//   已經是目標階段 → 其實成功了，不刪歷程
//   還是原本階段   → 真的沒執行，才刪歷程
//   讀不到／其他值 → 狀態不明，不刪歷程，回報給使用者手動確認
async function verifyScreeningStage_(storeId, env) {
  if (!env.SCREENING_API_TOKEN) return { verified: false };
  try {
    const res = await fetch(`${env.SCREENING_API_URL}?token=${encodeURIComponent(env.SCREENING_API_TOKEN)}`);
    const data = await res.json();
    const row = (data.rows || []).find(r => r.id === storeId);
    if (!row) return { verified: false };
    return { verified: true, stage: row.stage };
  } catch (e) {
    return { verified: false };
  }
}

// 回滾階段歷程（補償動作）：失敗本身只記錄，不再往外拋——拋出去會蓋掉 handleFunnelResult 真正要
// 回報的錯誤訊息，而且回滾失敗最壞情況只是多一筆孤兒歷程事件，人工清理即可，不是資料損壞。
async function rollbackStageHistory_(eventId, env) {
  if (!eventId) return;
  try {
    await fetch(env.GAS_VISIT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'deleteStageHistory', eventId, token: env.PLANNER_API_TOKEN }),
      redirect: 'follow',
    });
    await invalidateGvizCache_(env, env.SHEET_PLANNER, '階段歷程');
  } catch (e) { /* 回滾失敗不往外拋，見上方註解 */ }
}

// POST /api/funnel/result：A10「記結果」。action: advance/drop/keep/confirmed。
// 寫入順序固定：先寫階段歷程（唯一的事實記錄，失敗就整個中止）→ keep 到此結束；
// advance/drop/confirmed 才需要再寫篩選分頁階段，那一步失敗時走 verifyScreeningStage_ 核對再決定
// 要不要回滾，不清空前端表單內容（放棄原因不用重打），由前端自己保留使用者輸入。
async function handleFunnelResult(request, env, ctx) {
  const body = await request.json();
  const { storeId, storeName, action, dropReason, customerId, requestId } = body;
  if (!storeId) return json({ error: '缺少 storeId' }, 400);
  if (['advance', 'drop', 'keep', 'confirmed'].indexOf(action) < 0) {
    return json({ error: 'action 必須是 advance／drop／keep／confirmed' }, 400);
  }
  if (!env.SCREENING_API_TOKEN) return json({ error: '缺少 SCREENING_API_TOKEN（wrangler secret 未設定）' }, 500);

  const screeningRes = await fetch(`${env.SCREENING_API_URL}?token=${encodeURIComponent(env.SCREENING_API_TOKEN)}`).then(r => r.json());
  const row = (screeningRes.rows || []).find(r => r.id === storeId);
  if (!row) return json({ error: `篩選分頁找不到這家店：${storeId}` }, 404);
  const fromStage = row.stage;
  const stages = PLANNER_CONFIG.newStoreStages;
  const idx = stages.indexOf(fromStage);

  let toStage, stageAction;
  if (action === 'keep') {
    toStage = fromStage;
  } else if (action === 'advance') {
    // 2026-11-10 field-v2 階段1：拿掉「試賣中」階段，初訪後（idx===1）是現在最後一個能 advance 的
    // 階段，二訪後（idx===2）之後不再能用一般推進，只能 confirmed 或 drop（邊界跟 Code.gs 的
    // computeNextStage_ 同步）
    if (idx < 0 || idx > 1) {
      return json({ error: idx === 2 ? '二訪後之後請用「確認已建檔」或「放棄」，不能用一般推進' : '目前階段不允許推進' }, 400);
    }
    toStage = stages[idx + 1];
    stageAction = 'advance';
  } else if (action === 'drop') {
    if (idx < 0 || idx > 2) return json({ error: '目前階段不允許放棄（必須是發現～二訪後之一）' }, 400);
    if (!dropReason) return json({ error: '放棄必須填原因' }, 400);
    toStage = '放棄';
    stageAction = 'drop';
  } else { // confirmed
    if (idx < 0 || idx > 2) return json({ error: '目前階段不允許確認已建檔（必須是發現～二訪後之一）' }, 400);
    if (!customerId) return json({ error: '缺少 customerId' }, 400);
    const pharmaciesRes = await handleGetPharmacies(null, env, ctx).then(r => r.json());
    const exists = (pharmaciesRes.pharmacies || []).some(p => p.id === customerId);
    if (!exists) return json({ error: `新客戶資料表找不到代號：${customerId}，請確認有沒有打錯字` }, 400);
    // 2026-11-02 使用者要求：同一個正式代號不能被兩家開發中的店拿去轉正式（階段歷程裡已經有
    // 「到階段=轉正式」且「正式代號」相同、但店代號不同的紀錄，就擋下，避免同一個代號記錯店）
    const historyRowsForDupCheck = env.SHEET_PLANNER ? await fetchGvizRows(env.SHEET_PLANNER, '階段歷程', env, ctx) : [];
    const dup = historyRowsForDupCheck.find(h =>
      h.get('到階段') === '轉正式' && h.get('正式代號') === customerId && h.get('店代號') !== storeId);
    if (dup) {
      return json({ error: `代號 ${customerId} 已經被另一家開發中的店（${dup.get('店代號')} ${dup.get('店名')}）用在轉正式紀錄裡，請確認是不是打錯代號` }, 400);
    }
    toStage = '轉正式';
    stageAction = 'confirm';
  }

  // 第一步：寫階段歷程。失敗就整個中止，不碰篩選分頁——這是最安全的失敗模式，使用者可以直接重按。
  const historyRes = await fetch(env.GAS_VISIT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'addStageHistory', storeId, storeName: storeName || row.name,
      fromStage, toStage, source: 'A10', customerId: action === 'confirmed' ? customerId : '',
      requestId, token: env.PLANNER_API_TOKEN,
    }),
    redirect: 'follow',
  }).then(r => r.json()).catch(e => ({ success: false, error: String(e && e.message || e) }));

  if (!historyRes.success) {
    return json({
      success: false, stageUpdated: false, historyWritten: false,
      error: '階段歷程寫入失敗，沒有任何改動：' + (historyRes.error || '未知錯誤'),
    }, 502);
  }
  // 階段歷程寫成功了（之後無論 keep 還是繼續寫篩選分頁，這筆歷程都不會再被回滾），先清快取——
  // 下面所有分支的回應都可能被前端拿去重新整理畫面。
  await invalidateGvizCache_(env, env.SHEET_PLANNER, '階段歷程');

  // keep：只寫歷程，沒有第二個寫入點，到這裡就結束（篩選分頁階段文字本來就沒變）
  if (action === 'keep') {
    return json({ success: true, stageUpdated: false, historyWritten: true, stage: fromStage });
  }

  // 第二步：寫篩選分頁階段
  const screeningWrite = await callScreeningStageAction_(storeId, stageAction, dropReason, env);
  if (screeningWrite.ok) {
    return json({ success: true, stageUpdated: true, historyWritten: true, stage: screeningWrite.stage });
  }

  // 第二步「看起來」失敗——核對真正的狀態再決定要不要回滾（見 verifyScreeningStage_ 註解）
  const verify = await verifyScreeningStage_(storeId, env);
  if (verify.verified && verify.stage === toStage) {
    return json({
      success: true, stageUpdated: true, historyWritten: true, stage: verify.stage,
      warning: '篩選分頁的寫入回應異常，但核對後確認階段已經正確更新，階段歷程保留。',
    });
  }
  if (verify.verified && verify.stage === fromStage) {
    await rollbackStageHistory_(historyRes.eventId, env);
    return json({
      success: false, stageUpdated: false, historyWritten: false,
      error: '篩選分頁更新失敗：' + screeningWrite.error,
      detail: '已核對確認階段沒有被改動，剛寫入的階段歷程已回滾刪除，可以重新操作一次。',
    }, 502);
  }
  // 讀不到這家店，或讀到的階段既不是原本的也不是目標的——狀態不明，不刪歷程，交給人工確認
  return json({
    success: false, stageUpdated: null, historyWritten: true,
    error: '篩選分頁寫入後核對失敗，狀態不明，請手動檢查「藥局每日異動追蹤」篩選分頁這家店（' + storeId +
      '）目前的階段，並比對「階段歷程」分頁剛寫入的這筆事件（eventId=' + (historyRes.eventId || '未知') + '）是否需要人工修正。',
  }, 502);
}

// GET /api/funnel/overview：A10 頂部四個數字＋每欄卡片＋每欄轉換率。period: 30｜90｜ytd
async function handleFunnelOverview(request, env, ctx) {
  const url = new URL(request.url);
  const period = url.searchParams.get('period') || '90';
  const now = new Date();

  const [pharmaciesRes, screeningRows, stageHistoryRows] = await Promise.all([
    handleGetPharmacies(null, env, ctx).then(r => r.json()),
    env.SCREENING_API_TOKEN
      ? fetchScreeningRows_(env, ctx)
      : Promise.resolve([]),
    env.SHEET_PLANNER ? fetchGvizRows(env.SHEET_PLANNER, '階段歷程', env, ctx) : Promise.resolve([]),
  ]);

  const allPharmacies = pharmaciesRes.pharmacies || [];
  const possiblyConvertedIds = possiblyConvertedScreeningIds_(screeningRows, allPharmacies);
  const latestHistoryDate = latestStageHistoryDateByStore_(stageHistoryRows);
  const convertedCustomerId = convertedCustomerIdByStore_(stageHistoryRows);
  const devStages = ['發現', '初訪後', '二訪後'];
  const stages = PLANNER_CONFIG.newStoreStages;

  const cards = screeningRows
    .filter(r => r.decision === '要去' && r.stage)
    .map(r => {
      const effectiveDate = latestHistoryDate[r.id] || r.stageDate;
      const interval = PLANNER_CONFIG.stageIntervalDays[r.stage] || null;
      const daysSince = effectiveDate ? daysBetween(effectiveDate, now) : null;
      const ratio = (daysSince !== null && interval) ? Math.round((daysSince / interval) * 100) / 100 : null;
      return {
        id: r.id, name: r.name, city: r.city, district: r.district, address: r.address, stage: r.stage,
        daysSince, ratio, possiblyConverted: possiblyConvertedIds.has(r.id),
        dropReason: r.stage === '放棄' ? (r.dropReason || null) : null,
        customerId: r.stage === '轉正式' ? (convertedCustomerId[r.id] || null) : null,
      };
    });

  const developing = cards.filter(c => devStages.indexOf(c.stage) >= 0).length;
  const stuck = cards.filter(c => devStages.indexOf(c.stage) >= 0 && c.ratio !== null && c.ratio >= 1).length;

  // 期間篩選的起點（給「近90天轉正式家數」用，30/90 是天數，ytd 是今年 1/1）
  let periodStart = null;
  if (period === 'ytd') periodStart = new Date(now.getFullYear(), 0, 1);
  else { periodStart = new Date(now); periodStart.setDate(periodStart.getDate() - (Number(period) || 90)); }
  const periodStartStr = formatDateIso_(periodStart);

  // 轉正式家數：用階段歷程的「到階段=轉正式」事件算，不是數篩選分頁現在的「目前階段」文字——
  // 篩選分頁可能因為當場建檔漏標（見 possiblyConvertedScreeningIds_ 的註解）永遠停在舊階段，
  // 階段歷程才是記結果真正發生過的事實記錄，之後用 A10「確認已建檔」補記的轉正也會算進來。
  const convertedEvents = stageHistoryRows.filter(h => h.get('到階段') === '轉正式');
  const convertedInPeriod = convertedEvents.filter(h => { const d = h.get('日期'); return d && d >= periodStartStr; });

  // 發現到第一張正式單的平均天數：第一版還算不出來（見 docs/SPEC.md 討論）——需要「發現」事件的
  // 日期＋正式代號＋訂單主檔 join，階段歷程有了正式代號，但「發現」事件要等這個功能上線後才開始累積，
  // 現有資料不足，先回 null，前端顯示「資料累積中」。
  const avgDaysToFirstOrder = null;

  // 每欄轉換率：從階段歷程算「從 X 進來的不重複店數」vs「後來也出現過一筆 到階段=下一階段 的店數」。
  // 樣本數低於 funnelConversionMinSamples 時回 null，前端顯示「資料累積中」而不是誤導的百分比。
  function conversionRate_(fromStage) {
    const nextStage = stages[stages.indexOf(fromStage) + 1];
    const enteredIds = new Set(stageHistoryRows.filter(h => h.get('到階段') === fromStage).map(h => h.get('店代號')));
    if (enteredIds.size < PLANNER_CONFIG.funnelConversionMinSamples) {
      return { rate: null, samples: enteredIds.size };
    }
    const advancedCount = [...enteredIds].filter(id =>
      stageHistoryRows.some(h => h.get('店代號') === id && h.get('到階段') === nextStage)).length;
    return { rate: Math.round((advancedCount / enteredIds.size) * 1000) / 10, samples: enteredIds.size };
  }

  const columns = ['發現', '初訪後', '二訪後', '轉正式', '放棄'].map(stage => ({
    stage,
    intervalDays: PLANNER_CONFIG.stageIntervalDays[stage] || null,
    cards: cards.filter(c => c.stage === stage),
    conversion: (stage === '轉正式' || stage === '放棄') ? null : conversionRate_(stage),
  }));

  return json({
    ok: true,
    period,
    top: { developing, stuck, convertedInPeriod: convertedInPeriod.length, avgDaysToFirstOrder },
    columns,
    note: '轉正式家數/轉換率讀「階段歷程」分頁（事實記錄），不是篩選分頁現在的「目前階段」文字；' +
      '「發現到第一張正式單」第一版算不出來，見 docs/SPEC.md。',
  });
}

function formatDateIso_(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
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
