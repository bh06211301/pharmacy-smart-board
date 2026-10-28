// ==========================================
// SmartRoute 規劃流程 v2 — 第 1 階段：店家規則／待追蹤 讀寫
// doPost 的 action 分流寫在 VisitAppWebhook.js，實際處理都在這支檔案
// 寫入目標是 PlannerSetup.js 建立的「藥局規劃資料」試算表（PLANNER_SHEET_ID_PROP 這個指令碼屬性）
// ==========================================

// 2026-10-28：店家規則／待追蹤的新增/修改/刪除這幾個 action 要求帶 token，比對指令碼屬性裡的密鑰，
// 不符就拒絕——照抄 new-pharmacy-screening（apps-script/Code.gs 的 checkToken_）已經在用的做法，
// 同一套模式沿用，不是另外發明一套。密鑰存在指令碼屬性 PLANNER_API_TOKEN，要自己去「專案設定」→
// 「指令碼屬性」設定（Claude 不會也不該知道這個值）。檢查放在 doPost 的分流那一層（VisitAppWebhook.js），
// 不是放在這裡的 handle 函式裡——這樣 backfillC014Rule／testPlannerActions 這些直接呼叫 handle
// 函式、不經過 HTTP 的內部工具函式才不會被誤擋（它們本來就是在 Apps Script 編輯器裡手動執行的信任範圍內）。
const PLANNER_API_TOKEN_PROP = 'PLANNER_API_TOKEN';
function checkPlannerToken_(t) {
  const want = PropertiesService.getScriptProperties().getProperty(PLANNER_API_TOKEN_PROP);
  return want && t === want;
}

function plannerSheet_(name) {
  const id = PropertiesService.getScriptProperties().getProperty(PLANNER_SHEET_ID_PROP);
  if (!id) throw new Error('找不到 PLANNER_SHEET_ID，請先在 PlannerSetup.js 執行過 setupPlannerSheet()。');
  const sh = SpreadsheetApp.openById(id).getSheetByName(name);
  if (!sh) throw new Error('找不到「' + name + '」分頁。');
  return sh;
}

function findRow_(sh, cols, idColName, idVal) {
  const idCol = cols.indexOf(idColName) + 1;
  const last = sh.getLastRow();
  if (last < 2) return null;
  const vals = sh.getRange(2, idCol, last - 1, 1).getValues();
  for (let i = 0; i < vals.length; i++) {
    if (vals[i][0] === idVal) return i + 2;
  }
  return null;
}

// 2026-10-28：請求ID去重，只用在「新增」這種會 appendRow 的動作（update/resolve 本來就是改既有列，
// 重送頂多把同樣的值再設一次，不會變成兩筆）。前端在按鈕按下的當下就會 disabled 擋住同一顆按鈕的
// 重複點擊了（實際發生過的事故：新增待追蹤連點5次，因為按鈕看起來沒反應，建了5筆一樣的資料）——
// 這裡是故意疊上去的第二層保險，防的是前端攔不到的情況（例如瀏覽器/網路重送同一個 POST）。
// requestId 相同時，直接回傳快取住的上次結果，不要真的再 appendRow 一次。快取 6 小時（CacheService 上限），
// 不是永久保存，過期後同一個 requestId 理論上不會再被同一次使用者操作送出第二次，不需要更久。
function withRequestDedup_(requestId, fn) {
  if (!requestId) return fn();
  const cache = CacheService.getScriptCache();
  const cacheKey = 'planner_req_' + requestId;
  const cached = cache.get(cacheKey);
  if (cached) return ContentService.createTextOutput(cached).setMimeType(ContentService.MimeType.JSON);
  const output = fn();
  cache.put(cacheKey, output.getContent(), 21600);
  return output;
}

// ---- 店家規則 ----
// data: { storeId, ruleType, weekdays, monthDays, timeFrom, timeTo, note, action, source, requestId }
function handleAddRule_(data) {
  const { storeId, ruleType, weekdays, monthDays, timeFrom, timeTo, note, action, source, requestId } = data;
  if (!storeId) throw new Error('缺少店家代號');
  if (!ruleType || PLANNER_RULE_TYPES.indexOf(ruleType) < 0) throw new Error('規則類型不合法：' + ruleType);
  if (!action || PLANNER_RULE_ACTIONS.indexOf(action) < 0) throw new Error('排程處理不合法：' + action);
  if (source && PLANNER_RULE_SOURCES.indexOf(source) < 0) throw new Error('來源不合法：' + source);

  return withRequestDedup_(requestId, () => {
    const sh = plannerSheet_(PLANNER_RULE_SHEET);
    const ruleId = 'R' + Utilities.getUuid().slice(0, 8);
    const today = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd');
    sh.appendRow([ruleId, storeId, ruleType, weekdays || '', monthDays || '', timeFrom || '', timeTo || '',
      note || '', action, source || '自己', today, '有效']);
    forceMonthDaysAsText_(sh, sh.getLastRow(), monthDays);

    return ContentService.createTextOutput(JSON.stringify({ success: true, ruleId }))
      .setMimeType(ContentService.MimeType.JSON);
  });
}

// appendRow／setValue 寫「5-5」這種單日格式時，Sheets 會自動偵測成日期（當成「5/5」），
// 即使該欄已經用 setNumberFormat('@') 設成純文字也擋不住——這是實測發現的，
// 2026-10-25 建 C014 的「隔月5號請款」規則時中過一次（存成 Date(2026,4,5) 而不是文字「5-5」）。
// 寫完欄位後立刻重新 setNumberFormat('@') 再 setValue 一次，強制蓋回純文字，兩段分開呼叫才有效
function forceMonthDaysAsText_(sh, row, monthDays) {
  if (!monthDays) return;
  const col = PLANNER_RULE_COLS.indexOf('每月日期') + 1;
  sh.getRange(row, col).setNumberFormat('@');
  sh.getRange(row, col).setValue(String(monthDays));
}

// data: { ruleId, patch: { ruleType, weekdays, monthDays, timeFrom, timeTo, note, action, source, status } }
function handleUpdateRule_(data) {
  const { ruleId, patch } = data;
  if (!ruleId) throw new Error('缺少規則ID');
  const sh = plannerSheet_(PLANNER_RULE_SHEET);
  const row = findRow_(sh, PLANNER_RULE_COLS, '規則ID', ruleId);
  if (!row) throw new Error('找不到規則：' + ruleId);

  const FIELD_MAP = { ruleType: '規則類型', weekdays: '星期', monthDays: '每月日期', timeFrom: '時段起',
    timeTo: '時段迄', note: '說明', action: '排程處理', source: '來源', status: '狀態' };
  Object.keys(patch || {}).forEach(k => {
    const col = FIELD_MAP[k];
    if (!col) return;
    sh.getRange(row, PLANNER_RULE_COLS.indexOf(col) + 1).setValue(patch[k]);
  });
  if (patch && patch.monthDays) forceMonthDaysAsText_(sh, row, patch.monthDays); // 同一個「5-5」被誤判成日期的問題

  return ContentService.createTextOutput(JSON.stringify({ success: true }))
    .setMimeType(ContentService.MimeType.JSON);
}

// ---- 待追蹤 ----
// data: { storeId, item, who, deadlineType, deadline, requestId }
function handleAddFollowup_(data) {
  const { storeId, item, who, deadlineType, deadline, requestId } = data;
  if (!storeId) throw new Error('缺少店家代號');
  if (!item) throw new Error('缺少事項');
  if (who && PLANNER_FOLLOWUP_WHO.indexOf(who) < 0) throw new Error('誰交代不合法：' + who);
  if (deadlineType && PLANNER_FOLLOWUP_DEADLINE_TYPE.indexOf(deadlineType) < 0) throw new Error('期限類型不合法：' + deadlineType);

  return withRequestDedup_(requestId, () => {
    const sh = plannerSheet_(PLANNER_FOLLOWUP_SHEET);
    const followupId = 'T' + Utilities.getUuid().slice(0, 8);
    const today = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd');
    sh.appendRow([followupId, storeId, item, who || '我', deadlineType || '下次經過', deadline || '', today, '未完成', '', '']);

    return ContentService.createTextOutput(JSON.stringify({ success: true, followupId }))
      .setMimeType(ContentService.MimeType.JSON);
  });
}

// 2026-10-28：測試資料清理用（不接在任何使用者看得到的 UI 按鈕上），刪整列，不是標記狀態
// data: { ruleId }
function handleDeleteRule_(data) {
  const { ruleId } = data;
  if (!ruleId) throw new Error('缺少規則ID');
  const sh = plannerSheet_(PLANNER_RULE_SHEET);
  const row = findRow_(sh, PLANNER_RULE_COLS, '規則ID', ruleId);
  if (!row) throw new Error('找不到規則：' + ruleId);
  sh.deleteRow(row);
  return ContentService.createTextOutput(JSON.stringify({ success: true, deletedRow: row }))
    .setMimeType(ContentService.MimeType.JSON);
}
// data: { followupId }
function handleDeleteFollowup_(data) {
  const { followupId } = data;
  if (!followupId) throw new Error('缺少待追蹤ID');
  const sh = plannerSheet_(PLANNER_FOLLOWUP_SHEET);
  const row = findRow_(sh, PLANNER_FOLLOWUP_COLS, '待追蹤ID', followupId);
  if (!row) throw new Error('找不到待追蹤：' + followupId);
  sh.deleteRow(row);
  return ContentService.createTextOutput(JSON.stringify({ success: true, deletedRow: row }))
    .setMimeType(ContentService.MimeType.JSON);
}

// data: { followupId, resolvedFrom }
function handleResolveFollowup_(data) {
  const { followupId, resolvedFrom } = data;
  if (!followupId) throw new Error('缺少待追蹤ID');
  const sh = plannerSheet_(PLANNER_FOLLOWUP_SHEET);
  const row = findRow_(sh, PLANNER_FOLLOWUP_COLS, '待追蹤ID', followupId);
  if (!row) throw new Error('找不到待追蹤：' + followupId);

  const today = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd');
  sh.getRange(row, PLANNER_FOLLOWUP_COLS.indexOf('狀態') + 1).setValue('已完成');
  sh.getRange(row, PLANNER_FOLLOWUP_COLS.indexOf('完成日期') + 1).setValue(today);
  sh.getRange(row, PLANNER_FOLLOWUP_COLS.indexOf('完成來源') + 1).setValue(resolvedFrom || '');

  return ContentService.createTextOutput(JSON.stringify({ success: true }))
    .setMimeType(ContentService.MimeType.JSON);
}

// ===== 一次性：客戶資料表規則備註轉換（2026-10-25 跟使用者核對過）=====
// 查過全部 134 家客戶：「營業時間」126家有值但都是 Google 地圖自動帶入的制式週間時段，不是排程規則，不轉
// 「公休日」只有5家有值且全是「正常營業」「未提供」這種空泛文字，沒有一筆是具體規則，不轉
// 「備註」只有 C014 來福藥局一筆真的是規則：「隔月5號請款」。
// 使用者說明真正意思：寄賣通常約7個月才整理請款，來福是例外，下個月5號就要收——不是單純「每隔一個月」，
// 用「提醒」類型（不會擋排程），說明欄保留完整原意，每月日期先當每月提醒基準日，不會因為頻率不精確造成誤擋
function backfillC014Rule() {
  const resp = JSON.parse(handleAddRule_({
    storeId: 'C014',
    ruleType: '請款規則',
    monthDays: '5-5',
    note: '隔月5號請款（不走寄賣7個月）',
    action: '提醒',
    source: '自己',
  }).getContent());
  Logger.log(JSON.stringify(resp));
}

// ===== 一次性：修復 C014 規則被誤存成日期的「每月日期」欄（2026-10-25 發現，見 forceMonthDaysAsText_ 註解）=====
function fixC014MonthDays() {
  const sh = plannerSheet_(PLANNER_RULE_SHEET);
  const row = findRow_(sh, PLANNER_RULE_COLS, '規則ID', 'R9fd888fb');
  if (!row) throw new Error('找不到規則 R9fd888fb，可能已經修過或被刪了，請手動確認。');
  const before = sh.getRange(row, PLANNER_RULE_COLS.indexOf('每月日期') + 1).getValue();
  forceMonthDaysAsText_(sh, row, '5-5');
  const after = sh.getRange(row, PLANNER_RULE_COLS.indexOf('每月日期') + 1).getValue();
  Logger.log('修復前：' + before + '　修復後：' + after);
}

// ===== 待追蹤加分驗證用（分兩步，中間 Claude 要用 wrangler dev 查 /api/plan 分數有沒有變化）=====
// 1. 先執行 addTestFollowupForScoring，建一筆真的待追蹤（店家代號 C014，期限類型「下次經過」，應該 +10 分）
// 2. 確認 /api/plan 的 C014 分數有加分、followupItems 有出現這筆之後，執行 cleanupTestFollowups 刪掉
function addTestFollowupForScoring() {
  const resp = JSON.parse(handleAddFollowup_({
    storeId: 'C014', item: '__測試__驗證待追蹤加分', who: '帳務', deadlineType: '下次經過',
  }).getContent());
  Logger.log(JSON.stringify(resp));
}

function cleanupTestFollowups() {
  const sh = plannerSheet_(PLANNER_FOLLOWUP_SHEET);
  const last = sh.getLastRow();
  if (last < 2) { Logger.log('沒有資料可清。'); return; }
  const itemCol = PLANNER_FOLLOWUP_COLS.indexOf('事項') + 1;
  const vals = sh.getRange(2, itemCol, last - 1, 1).getValues();
  const toDelete = [];
  vals.forEach((r, i) => { if (String(r[0]).indexOf('__測試__') >= 0) toDelete.push(2 + i); });
  toDelete.sort((a, b) => b - a).forEach(r => sh.deleteRow(r));
  Logger.log('刪除了 ' + toDelete.length + ' 筆測試待追蹤。');
}

// ===== 自我清理測試：直接呼叫上面 4 個 handle 函式，不經 HTTP，驗證完自動刪除測試列 =====
function testPlannerActions() {
  const results = [];
  function check(label, cond) { results.push((cond ? '✅ ' : '❌ ') + label); }

  const ruleSheet = plannerSheet_(PLANNER_RULE_SHEET);
  const followupSheet = plannerSheet_(PLANNER_FOLLOWUP_SHEET);
  let ruleId, followupId;

  try {
    // 店家規則：新增 → 檢查欄位 → 修改 → 檢查修改生效
    const addRuleResp = JSON.parse(handleAddRule_({
      storeId: '__TEST_STORE__', ruleType: '不拜訪日', weekdays: '一、三', monthDays: '5-5',
      action: '擋住', source: '自己', note: '測試規則'
    }).getContent());
    check('店家規則新增成功', addRuleResp.success === true);
    ruleId = addRuleResp.ruleId;
    let ruleRow = findRow_(ruleSheet, PLANNER_RULE_COLS, '規則ID', ruleId);
    check('店家規則找得到剛新增的列', !!ruleRow);
    const ruleVals = ruleSheet.getRange(ruleRow, 1, 1, PLANNER_RULE_COLS.length).getValues()[0];
    check('店家規則欄位正確（店家代號/規則類型/星期/排程處理）',
      ruleVals[1] === '__TEST_STORE__' && ruleVals[2] === '不拜訪日' && ruleVals[3] === '一、三' && ruleVals[8] === '擋住');
    // 2026-10-25 補：「5-5」這種單日格式曾經被 Sheets 自動吃成日期（C014 踩過），這裡擋住不讓它再發生
    const monthDaysVal = ruleSheet.getRange(ruleRow, PLANNER_RULE_COLS.indexOf('每月日期') + 1).getValue();
    check('每月日期存的是文字「5-5」，不是被轉成日期', monthDaysVal === '5-5');

    const updateRuleResp = JSON.parse(handleUpdateRule_({ ruleId, patch: { status: '停用' } }).getContent());
    check('店家規則修改成功', updateRuleResp.success === true);
    const statusAfter = ruleSheet.getRange(ruleRow, PLANNER_RULE_COLS.indexOf('狀態') + 1).getValue();
    check('店家規則狀態改成停用', statusAfter === '停用');

    // 待追蹤：新增 → 檢查欄位 → 結案 → 檢查結案欄位
    const addFollowupResp = JSON.parse(handleAddFollowup_({
      storeId: '__TEST_STORE__', item: '測試事項', who: '帳務', deadlineType: '指定日期前', deadline: '2026-12-31'
    }).getContent());
    check('待追蹤新增成功', addFollowupResp.success === true);
    followupId = addFollowupResp.followupId;
    let followupRow = findRow_(followupSheet, PLANNER_FOLLOWUP_COLS, '待追蹤ID', followupId);
    check('待追蹤找得到剛新增的列', !!followupRow);
    const followupVals = followupSheet.getRange(followupRow, 1, 1, PLANNER_FOLLOWUP_COLS.length).getValues()[0];
    check('待追蹤欄位正確（店家代號/事項/誰交代/狀態=未完成）',
      followupVals[1] === '__TEST_STORE__' && followupVals[2] === '測試事項' && followupVals[3] === '帳務' && followupVals[7] === '未完成');

    const resolveResp = JSON.parse(handleResolveFollowup_({ followupId, resolvedFrom: '測試結案' }).getContent());
    check('待追蹤結案成功', resolveResp.success === true);
    const statusAfter2 = followupSheet.getRange(followupRow, PLANNER_FOLLOWUP_COLS.indexOf('狀態') + 1).getValue();
    const doneDate = followupSheet.getRange(followupRow, PLANNER_FOLLOWUP_COLS.indexOf('完成日期') + 1).getValue();
    check('待追蹤狀態改成已完成且有填完成日期', statusAfter2 === '已完成' && !!doneDate);

    // 負向測試：不合法的規則類型應該直接丟錯，不會寫入
    let threw = false;
    try { handleAddRule_({ storeId: '__TEST_STORE__', ruleType: '亂打的', action: '擋住' }); } catch (e) { threw = true; }
    check('不合法的規則類型會被擋下來（丟錯，不寫入）', threw);
  } finally {
    if (ruleId) { const r = findRow_(ruleSheet, PLANNER_RULE_COLS, '規則ID', ruleId); if (r) ruleSheet.deleteRow(r); }
    if (followupId) { const r = findRow_(followupSheet, PLANNER_FOLLOWUP_COLS, '待追蹤ID', followupId); if (r) followupSheet.deleteRow(r); }
  }

  Logger.log(results.join('\n'));
  Logger.log(results.every(r => r.indexOf('✅') === 0) ? '全部通過，測試列已清除。' : '有測試沒通過，請檢查上面的 log，測試列已清除。');
}

// ==========================================
// 一次性：補簽約店進「客戶合約」試算表（2026-10-27，使用者確認的 7 家，C064 已存在不重複）
// 跟 PLANNER_SHEET_ID_PROP（藥局規劃資料）是不同的試算表，獨立用固定 ID 開啟。
// dryRunSeedCustomerContracts() 先看結果，確認沒問題再執行 applySeedCustomerContracts() 真的寫入。
// ==========================================
const CONTRACT_SHEET_ID = '10zWisKoSqiMS1v6hwzy4lzIs4CkkCBhuhetN7_jlsbU';
const CONTRACT_SHEET_NAME = '客戶合約';

function seedCustomerContracts_(execute) {
  const sheet = SpreadsheetApp.openById(CONTRACT_SHEET_ID).getSheetByName(CONTRACT_SHEET_NAME);
  if (!sheet) throw new Error('找不到「客戶合約」分頁');

  const newContracts = [
    { id: 'C056', amount: 30000 },
    { id: 'C053', amount: 100000 },
    { id: 'C054', amount: 50000 },
    { id: 'C043', amount: 50000 },
    { id: 'C074', amount: 100000 },
    { id: 'C104', amount: 100000 },
    { id: 'C008', amount: 50000 },
  ];

  // 防呆：先讀現有的 Customer_ID（B欄），已經存在的跳過，避免重複寫入（例如重複執行這個函式）
  const lastRow = sheet.getLastRow();
  const existingIds = new Set();
  if (lastRow > 1) {
    sheet.getRange(2, 2, lastRow - 1, 1).getValues().forEach(r => { if (r[0]) existingIds.add(String(r[0]).trim()); });
  }

  const results = [];
  const rowsToWrite = [];
  newContracts.forEach(c => {
    if (existingIds.has(c.id)) {
      results.push(c.id + '：已存在，跳過不重複寫入');
      return;
    }
    const contractId = c.id + '-1';
    rowsToWrite.push([contractId, c.id, '', c.amount, '']);
    results.push(contractId + '\t' + c.id + '\t切口金額=' + c.amount + '\t合約起始日=(空白)\t合約狀態=(空白)');
  });

  const msg = (execute ? '已寫入：\n' : 'Dry run（尚未寫入）：\n') + results.join('\n');
  Logger.log(msg);

  if (execute && rowsToWrite.length) {
    const startRow = sheet.getLastRow() + 1;
    sheet.getRange(startRow, 1, rowsToWrite.length, 5).setValues(rowsToWrite);
    Logger.log('已寫入 ' + rowsToWrite.length + ' 列。');
  }

  return msg;
}

function dryRunSeedCustomerContracts() {
  return seedCustomerContracts_(false);
}

function applySeedCustomerContracts() {
  return seedCustomerContracts_(true);
}
