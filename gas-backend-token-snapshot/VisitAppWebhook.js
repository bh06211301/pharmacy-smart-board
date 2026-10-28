const INVENTORY_SHEET_ID = '1MpGBRGjd5geqU5K3Qh1SVp-RqrBXlasuYQWb2PfSw6w';
const PHARMACY_SHEET_ID = '1qJ62K5Hd2bKP9DdQTjwJOOy0njNICMSPiayW7YJZdNM';

// 「未建檔店家」暫存清單：跟正式客戶表同一個試算表（PHARMACY_SHEET_ID），但是獨立分頁
const TEMP_SHEET_NAME = '未建檔店家';
// 2026-10-27 補「疑似對應」欄：店名自動比對規則沒把握時只寫這欄讓使用者自己確認，不動「已轉正」
// （新增前要先手動跑一次 addSuspectedMatchColumnToTempSheet() 幫既有分頁表頭補上這欄）
const TEMP_COLS = ['id', '店名', '地址', '電話', '職稱', '稱呼', '緯度', '經度', '首次拜訪日', '最近拜訪日', '拜訪次數', '已轉正', '疑似對應'];

// 客戶建檔紀錄：跟正式客戶表同一個試算表，統一變更紀錄的第一步（只記「新增客戶」這個風險最高的動作）
const CUSTOMER_LOG_SHEET_NAME = '客戶建檔紀錄';
const CUSTOMER_LOG_COLS = ['時間', 'Customer_ID', '店名', '來源'];

// 一次性：木木好藥局已經正式建檔成 C137（使用者確認過），把今天那筆拜訪紀錄的店名欄從
// 暫存代碼 f3e4049d69（未建檔店家流程留下的）改成正式的 Customer_ID
function fixMuMuHaoVisitStoreCode() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('拜訪紀錄表');
  if (!sheet) throw new Error('找不到拜訪紀錄表分頁');
  const lastRow = sheet.getLastRow();
  const data = sheet.getRange(1, 1, lastRow, 2).getValues(); // A: Visit ID, B: 店名
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === 'd2f5530f') {
      if (data[i][1] !== 'f3e4049d69') {
        throw new Error('Visit ID d2f5530f 目前的店名是「' + data[i][1] + '」，跟預期的「f3e4049d69」不一致，停止執行。');
      }
      sheet.getRange(i + 1, 2).setValue('C137');
      Logger.log('已把 Visit ID d2f5530f 的店名改成 C137。');
      return;
    }
  }
  throw new Error('找不到 Visit ID d2f5530f。');
}

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);

    if (data.action === 'inventorySubmit') {
      return handleInventorySubmit_(data);
    }

    if (data.action === 'newPharmacy') {
      return handleNewPharmacy_(data);
    }

    if (data.action === 'upsertTempPharmacy') {
      return handleUpsertTempPharmacy_(data);
    }

    if (data.action === 'updatePharmacyFlag') {
      return handleUpdatePharmacyFlag_(data);
    }

    // SmartRoute 規劃流程 v2 第 1 階段：店家規則／待追蹤（寫入「藥局規劃資料」試算表，見 PlannerActions.js）。
    // 2026-10-28：這 6 個 action 改成要求帶 token（PlannerActions.js 的 checkPlannerToken_），
    // 統一在這裡（doPost 分流層）擋，不是放進每個 handle 函式——這樣 PlannerActions.js 裡那些
    // 直接呼叫 handle 函式、不經 HTTP 的內部工具（backfillC014Rule／testPlannerActions 等）才不會被誤擋。
    // 拜訪紀錄App在用的其他action（預設分支/inventorySubmit/newPharmacy/upsertTempPharmacy/
    // updatePharmacyFlag）先不加，見 CLAUDE.md 待辦。
    const PLANNER_TOKEN_REQUIRED_ACTIONS = ['addRule', 'updateRule', 'addFollowup', 'resolveFollowup', 'deleteFollowup', 'deleteRule'];
    if (PLANNER_TOKEN_REQUIRED_ACTIONS.indexOf(data.action) >= 0 && !checkPlannerToken_(data.token)) {
      return ContentService.createTextOutput(JSON.stringify({ success: false, error: 'bad_token' }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    if (data.action === 'addRule') {
      return handleAddRule_(data);
    }

    if (data.action === 'updateRule') {
      return handleUpdateRule_(data);
    }

    if (data.action === 'addFollowup') {
      return handleAddFollowup_(data);
    }

    if (data.action === 'resolveFollowup') {
      return handleResolveFollowup_(data);
    }

    // 2026-10-28：測試資料清理用（例如 Playwright 自動化測試按鈕點擊會建立測試列），
    // 不接在任何使用者看得到的 UI 按鈕上，只給 Claude 測試後清理用
    if (data.action === 'deleteFollowup') {
      return handleDeleteFollowup_(data);
    }
    if (data.action === 'deleteRule') {
      return handleDeleteRule_(data);
    }

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName('拜訪紀錄表');

    if (!sheet) throw new Error('找不到拜訪紀錄表分頁');

    sheet.appendRow([
      data.visitId || '',                                       // A: Visit ID
      data.pharmacy || data.pharmacyName || '',                 // B: 店名
      data.date || '',                                          // C: 拜訪日期
      data.visitType || data.purpose || '',                     // D: 拜訪目的
      data.note || data.content || '',                          // E: 拜訪內容（原始）
      '',                                                       // F: 現場照片
      '',                                                       // G: 下次追蹤日
      '',                                                       // H: Audio File
      data.action === 'addVisit' ? 'Manual' : 'Success',       // I: AI Status
      data.summary || '',                                       // J: Summary
      data.painPoints || '',                                    // K: Pain Points
      data.actionItems || '',                                   // L: Action Items
      data.tags || '',                                          // M: Tags
      data.rawTranscript || ''                                  // N: 原始逐字稿
    ]);
    
    return ContentService
      .createTextOutput(JSON.stringify({success: true}))
      .setMimeType(ContentService.MimeType.JSON);
  } catch(err) {
    return ContentService
      .createTextOutput(JSON.stringify({success: false, error: err.toString()}))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// 一次性：清掉 2026-10-25 部署驗證時用 curl 直接打正式網址測試寫入留下的假拜訪紀錄
// （curl 顯示 411 但 doPost 其實已經在伺服器端執行成功，所以留了 3 筆假資料）
// 只刪最後面、精確符合這次測試特徵的列，不符合就跳過不刪，執行完這個函式可以刪了
function cleanupDeployTestVisits_() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('拜訪紀錄表');
  const lastRow = sheet.getLastRow();
  const scanFrom = Math.max(2, lastRow - 9); // 保守起見往前多看幾列，只刪符合特徵的
  const vals = sheet.getRange(scanFrom, 1, lastRow - scanFrom + 1, 14).getValues();
  const toDelete = [];
  vals.forEach((r, i) => {
    const row = scanFrom + i;
    const [visitId, shop, date, , note, , , , aiStatus] = r;
    const isMarked = shop === '__DEPLOY_TEST_請刪除__';
    const isBlankTest = !visitId && !shop && !date && !note && aiStatus === 'Success';
    if (isMarked || isBlankTest) toDelete.push(row);
  });
  toDelete.sort((a, b) => b - a).forEach(r => sheet.deleteRow(r)); // 由大到小刪，避免行號位移
  Logger.log('刪除了 ' + toDelete.length + ' 列測試資料：row ' + toDelete.join(', '));
}

function doGet(e) {
  return ContentService
    .createTextOutput(JSON.stringify({status: 'ok'}))
    .setMimeType(ContentService.MimeType.JSON);
}

// 盤點批次寫入：1 筆盤點主檔 + N 筆盤點明細（寫到 SHEET_INVENTORY，跨試算表）
function handleInventorySubmit_(data) {
  const { sessionId, visitId, customerId, inventoryDate, items } = data;
  if (!sessionId || !customerId || !Array.isArray(items) || !items.length) {
    throw new Error('缺少 sessionId / customerId / items');
  }

  const ss = SpreadsheetApp.openById(INVENTORY_SHEET_ID);

  const masterSheet = ss.getSheetByName('盤點主檔');
  if (!masterSheet) throw new Error('找不到盤點主檔分頁');
  masterSheet.appendRow([sessionId, visitId || '', customerId, inventoryDate || '']);

  const detailSheet = ss.getSheetByName('盤點明細');
  if (!detailSheet) throw new Error('找不到盤點明細分頁');
  const rows = items.map(it => [
    Utilities.getUuid().slice(0, 8),
    sessionId,
    it.productId || '',
    it.productName || '',
    it.qty !== undefined && it.qty !== null ? it.qty : '',
    it.note || '',
    it.expiry || '',
  ]);
  detailSheet.getRange(detailSheet.getLastRow() + 1, 1, rows.length, 7).setValues(rows);

  return ContentService
    .createTextOutput(JSON.stringify({ success: true, sessionId, itemCount: rows.length }))
    .setMimeType(ContentService.MimeType.JSON);
}

// 新案開發當場建檔：寫入新客戶資料表_AppSheet，產生正式 Customer_ID（跨試算表）
// 縣市/行政區/郵遞區號比照 AppSheet 原本的 Initial Value 公式邏輯計算：
//   縣市/行政區：從地址開頭文字解析（不像 AppSheet 原公式靠地址開頭的郵遞區號數字，
//                因為現有地址資料都沒有打郵遞區號數字，那個公式現在其實也抓不到）
//   郵遞區號：ANY(SELECT(郵遞區號對照[郵遞區號], AND([縣市]=SUBSTITUTE(本列縣市,"台","臺"), [行政區]=本列行政區)))
function handleNewPharmacy_(data) {
  const { name, addr, tel, keyManTitle, keyManName, owner, lat, lng } = data;
  if (!name) throw new Error('缺少店名');

  const ss = SpreadsheetApp.openById(PHARMACY_SHEET_ID);
  const sheet = ss.getSheetByName('新客戶資料表_AppSheet');
  if (!sheet) throw new Error('找不到新客戶資料表_AppSheet分頁');

  // 欄位順序：Customer_ID,店名,狀態,等級,郵遞區號,縣市,行政區,地址,GPS,電話,Key Man,稱呼,統編,
  //          發票需求,Line ID,營業時間,公休日,備註,店家照片,Last_Updated,一年內累計實收,實體資料夾,
  //          緯度,經度,Customer_ID_Num,停用,負責人
  // ⚠️ 「Key Man」欄實際存的是職稱（如「藥師」），「稱呼」欄存的才是姓名——跟欄名字面意思相反，
  // 但既有資料與前端顯示邏輯（${title} ${keyMan}）都依賴這個對應，寫入時務必保持一致
  // 「負責人」是 2026-10-13 在 AppSheet 編輯器自建的 Enum 欄（我／老爸），落在試算表最後一欄
  const lastRow = sheet.getLastRow();
  let maxNum = 0;
  if (lastRow > 1) {
    const idNums = sheet.getRange(2, 25, lastRow - 1, 1).getValues();
    idNums.forEach(r => { const n = Number(r[0]); if (!isNaN(n) && n > maxNum) maxNum = n; });
  }
  const nextNum = maxNum + 1;
  const nextId = 'C' + String(nextNum).padStart(3, '0');

  const m = (addr || '').match(/^(.{2,3}[市縣])(.{2,3}[市區鄉鎮])/);
  const county = m ? m[1] : '';
  const district = m ? m[2] : '';

  let zip = '';
  if (county && district) {
    const zipSheet = ss.getSheetByName('郵遞區號對照');
    if (zipSheet) {
      const zipData = zipSheet.getDataRange().getValues();
      const normCounty = county.replace(/台/g, '臺');
      for (let i = 1; i < zipData.length; i++) {
        if (zipData[i][0] === normCounty && zipData[i][1] === district) { zip = zipData[i][2]; break; }
      }
    }
  }

  const gps = (lat && lng) ? `${lat}, ${lng}` : '';

  sheet.appendRow([
    nextId, name, '', '', zip, county, district, addr || '', gps, tel || '',
    keyManTitle || '', keyManName || '', '', '', '', '', '', '', '', '', '', '',
    lat || '', lng || '', nextNum, '', owner || '我'
  ]);

  // 如果這家店之前用「只記這次拜訪」存過暫存紀錄，正式建檔後把那筆標記轉正，
  // 避免 App 清單裡同一家店同時出現「未建檔」跟「正式客戶」兩筆
  const convertedFromTemp = markTempPharmacyConverted_(ss, addr, name, nextId);

  // 統一變更紀錄（做法A）：新增客戶是風險最高的寫入動作（GPS反解地址/AI判斷出錯就直接變成正式客戶資料），
  // 記下時間跟來源，之後資料有問題至少查得到是哪個管道建的
  logCustomerCreation_(ss, nextId, name, convertedFromTemp ? 'App現場建檔（原未記錄店家轉正）' : 'App現場建檔');

  return ContentService
    .createTextOutput(JSON.stringify({ success: true, customerId: nextId, zip, county, district }))
    .setMimeType(ContentService.MimeType.JSON);
}

// ========== 未建檔店家暫存清單 ==========
// 地址正規化去重，沿用 new-pharmacy-screening/apps-script/Code.gs 的 normKey/idOf 模式，
// 這裡複製一份獨立私有版本（不同 GAS 專案不能共用程式碼）
function normKey_(addr) {
  let a = String(addr || '').normalize('NFKC').replace(/臺/g, '台');
  a = a.replace(/^(台北市|新北市|基隆市|桃園市|新竹市|新竹縣)/, '');
  a = a.replace(/^(\S{1,3}?[區鄉鎮市])/, '');
  a = a.replace(/^\S{1,4}?里(?=\S*[路街道])/, '');
  a = a.replace(/\d+鄰/g, '');
  a = a.replace(/[（(].*?[)）]/g, '');
  a = a.replace(/(一|1|１)?[、,]?(二|2)?樓.*$/, '');
  a = a.replace(/之/g, '-').replace(/一段/g, '1段').replace(/二段/g, '2段').replace(/三段/g, '3段').replace(/四段/g, '4段');
  const m = a.match(/^(.*?號)/);
  return m ? m[1] : a;
}

function idOf_(key) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, key, Utilities.Charset.UTF_8);
  return bytes.map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('').slice(0, 10);
}

// 地址空白時退回用店名當 key，避免多家空地址店家的 id 全部撞在一起
function tempKeyOf_(addr, name) {
  const normName = String(name || '').normalize('NFKC').trim();
  return addr ? '地址:' + normKey_(addr) : '店名:' + normName;
}

function getOrCreateTempSheet_(ss) {
  let sheet = ss.getSheetByName(TEMP_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(TEMP_SHEET_NAME);
    sheet.appendRow(TEMP_COLS);
  }
  return sheet;
}

function readTempSheet_(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  const vals = sheet.getRange(2, 1, lastRow - 1, TEMP_COLS.length).getValues();
  return vals.map((r, i) => {
    const o = { _row: i + 2 };
    TEMP_COLS.forEach((c, j) => { o[c] = r[j]; });
    return o;
  }).filter(o => o.id);
}

// 「只記這次拜訪」upsert：同一家店（地址正規化後相同）第二次拜訪時更新既有列，
// 不存在就新增一列；非空欄位覆蓋舊值，空白欄位保留舊值（避免第二次漏填把舊資料洗掉）
function handleUpsertTempPharmacy_(data) {
  const { name, addr, tel, keyManTitle, keyManName, lat, lng } = data;
  if (!name) throw new Error('缺少店名');

  const ss = SpreadsheetApp.openById(PHARMACY_SHEET_ID);
  const sheet = getOrCreateTempSheet_(ss);
  const key = tempKeyOf_(addr, name);
  const id = idOf_(key);
  const today = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd');

  const rows = readTempSheet_(sheet);
  const old = rows.find(r => r.id === id);

  const telCol = TEMP_COLS.indexOf('電話') + 1;

  if (old) {
    const merged = {
      店名: name || old.店名,
      地址: addr || old.地址,
      電話: tel || old.電話,
      職稱: keyManTitle || old.職稱,
      稱呼: keyManName || old.稱呼,
      緯度: lat || old.緯度,
      經度: lng || old.經度,
      拜訪次數: (Number(old.拜訪次數) || 0) + 1
    };
    sheet.getRange(old._row, TEMP_COLS.indexOf('店名') + 1, 1, 6).setValues([[
      merged.店名, merged.地址, merged.電話, merged.職稱, merged.稱呼, merged.緯度
    ]]);
    // 電話欄要緊接著值一起設成純文字格式，否則 Sheets 偵測到純數字字串會自動轉成數字、吃掉開頭的 0
    sheet.getRange(old._row, telCol).setNumberFormat('@').setValue(merged.電話);
    sheet.getRange(old._row, TEMP_COLS.indexOf('經度') + 1).setValue(merged.經度);
    sheet.getRange(old._row, TEMP_COLS.indexOf('最近拜訪日') + 1).setValue(today);
    sheet.getRange(old._row, TEMP_COLS.indexOf('拜訪次數') + 1).setValue(merged.拜訪次數);

    return ContentService
      .createTextOutput(JSON.stringify({
        success: true, id, name: merged.店名, addr: merged.地址, tel: merged.電話,
        keyManTitle: merged.職稱, keyManName: merged.稱呼, visitCount: merged.拜訪次數,
        sheetId: sheet.getSheetId()
      }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  const newRow = sheet.getLastRow() + 1;
  sheet.getRange(newRow, 1, 1, TEMP_COLS.length).setValues([[
    id, name, addr || '', '', keyManTitle || '', keyManName || '', lat || '', lng || '', today, today, 1, ''
  ]]);
  // 同上，電話要在設完純文字格式之後才寫入，避免開頭的 0 被吃掉
  sheet.getRange(newRow, telCol).setNumberFormat('@').setValue(tel || '');

  return ContentService
    .createTextOutput(JSON.stringify({
      success: true, id, name, addr: addr || '', tel: tel || '',
      keyManTitle: keyManTitle || '', keyManName: keyManName || '', visitCount: 1,
      sheetId: sheet.getSheetId()
    }))
    .setMimeType(ContentService.MimeType.JSON);
}

// 正式建檔成功後，比對「未建檔店家」分頁有沒有同一家店，有就標記已轉正（存新 Customer_ID）
// 只標記不刪除，避免動到其他列的列號索引。回傳是否有比對到，給變更紀錄標註來源細節用
function markTempPharmacyConverted_(ss, addr, name, customerId) {
  const sheet = ss.getSheetByName(TEMP_SHEET_NAME);
  if (!sheet) return false;
  const key = tempKeyOf_(addr, name);
  const id = idOf_(key);
  const rows = readTempSheet_(sheet);
  const old = rows.find(r => r.id === id);
  if (old) {
    sheet.getRange(old._row, TEMP_COLS.indexOf('已轉正') + 1).setValue(customerId);
    return true;
  }
  return false;
}

// 死客戶標記／負責人（我／老爸）指派：直接寫回 新客戶資料表_AppSheet 的 停用(Z,第26欄) / 負責人(AA,第27欄)
// 2026-10-24 取代原本各自獨立的「客戶狀態」分頁代理（GAS_URL，原始碼已不存在於本機）跟 dad:pharmacies KV，
// 兩種標記都已經直接欄位化在主表上，PharmacySmartBoard worker.js 的 /customer-status、/dad-pharmacies 改呼叫這裡寫入
function handleUpdatePharmacyFlag_(data) {
  const { id, field, value } = data;
  if (!id) throw new Error('缺少 Customer_ID');
  if (field !== 'dead' && field !== 'dad') throw new Error('field 必須是 dead 或 dad');

  const ss = SpreadsheetApp.openById(PHARMACY_SHEET_ID);
  const sheet = ss.getSheetByName('新客戶資料表_AppSheet');
  if (!sheet) throw new Error('找不到新客戶資料表_AppSheet分頁');

  const col = field === 'dead' ? 26 : 27; // Z: 停用, AA: 負責人
  const lastRow = sheet.getLastRow();
  const ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) {
    if (ids[i][0] === id) {
      sheet.getRange(i + 2, col).setValue(value || '');
      return ContentService
        .createTextOutput(JSON.stringify({ success: true, id, field, value: value || '' }))
        .setMimeType(ContentService.MimeType.JSON);
    }
  }
  throw new Error('找不到 Customer_ID：' + id);
}

// 統一變更紀錄（做法A）：新增一筆到「客戶建檔紀錄」分頁，分頁不存在就自動建立
function logCustomerCreation_(ss, customerId, name, source) {
  let sheet = ss.getSheetByName(CUSTOMER_LOG_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(CUSTOMER_LOG_SHEET_NAME);
    sheet.appendRow(CUSTOMER_LOG_COLS);
  }
  const now = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd HH:mm:ss');
  sheet.appendRow([now, customerId, name, source]);
}

// 一次性：幫既有「未建檔店家」分頁的表頭補上「疑似對應」欄（2026-10-27 店名比對功能用）。
// 只在表頭還沒有這欄時才新增，不會動到任何既有資料；要先手動執行這個再執行比對函式。
function addSuspectedMatchColumnToTempSheet() {
  const ss = SpreadsheetApp.openById(PHARMACY_SHEET_ID);
  const sheet = ss.getSheetByName(TEMP_SHEET_NAME);
  if (!sheet) throw new Error('找不到「未建檔店家」分頁');
  const lastCol = sheet.getLastColumn();
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  if (headers.indexOf('疑似對應') >= 0) {
    Logger.log('「疑似對應」欄已經存在，不用新增');
    return;
  }
  sheet.getRange(1, lastCol + 1).setValue('疑似對應');
  Logger.log('已在第 ' + (lastCol + 1) + ' 欄新增「疑似對應」表頭');
}

// ========== 店名自動比對：未建檔店家 ↔ 新客戶資料表_AppSheet ==========
// 2026-10-27 使用者確認的規則：
//   1. 比對前先整理店名：去空白、拿掉「藥局/藥房/藥師/健保/中西/生活/藥妝」這類常見字
//   2. 整理後完全相同、且只對到一家 → 自動填「已轉正」
//   3. 其他可疑狀況（一個名字包含另一個／整理後只差一個字／完全相同但對到多家）
//      → 只寫「疑似對應」欄讓使用者自己確認，不自動填「已轉正」；
//        「疑似對應」已有值就不重寫，避免每天對同一組重複產生待確認
//        （同音比對先不做——先跟使用者討論過 Apps Script 裡做中文轉拼音的做法，
//        等實際字集大小評估後再補，不要一開始就掛大型拼音套件）
//   4. dryRun 模式完全不寫入，只回傳每一家未轉正店家的比對結果，供使用者檢查規則準不準

// 店名整理：去空白＋拿掉常見詞，兩邊比對前都要套這個，不能只套一邊
function simplifyPharmacyName_(name) {
  let s = String(name || '').normalize('NFKC').replace(/\s+/g, '');
  ['藥局', '藥房', '藥師', '健保', '中西', '生活', '藥妝'].forEach(w => { s = s.split(w).join(''); });
  return s;
}

// 判斷兩個字串是否剛好差一個字（插入/刪除/替換任一種都算），長度相差超過1直接排除
function isOneCharDiff_(a, b) {
  if (a === b) return false;
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > 1) return false;

  if (la === lb) {
    let diffCount = 0;
    for (let i = 0; i < la; i++) {
      if (a[i] !== b[i]) diffCount++;
      if (diffCount > 1) return false;
    }
    return diffCount === 1;
  }

  const shortS = la < lb ? a : b;
  const longS = la < lb ? b : a;
  let i = 0, j = 0, foundGap = false;
  while (i < shortS.length && j < longS.length) {
    if (shortS[i] === longS[j]) { i++; j++; continue; }
    if (foundGap) return false;
    foundGap = true;
    j++;
  }
  return true;
}

function matchTempPharmacyNames_(dryRun) {
  const ss = SpreadsheetApp.openById(PHARMACY_SHEET_ID);
  const tempSheet = ss.getSheetByName(TEMP_SHEET_NAME);
  if (!tempSheet) throw new Error('找不到「未建檔店家」分頁');
  const custSheet = ss.getSheetByName('新客戶資料表_AppSheet');
  if (!custSheet) throw new Error('找不到新客戶資料表_AppSheet分頁');

  const custLastRow = custSheet.getLastRow();
  const custRows = custLastRow > 1 ? custSheet.getRange(2, 1, custLastRow - 1, 2).getValues() : [];
  const customers = custRows
    .map(r => ({ id: r[0], name: r[1], simplified: simplifyPharmacyName_(r[1]) }))
    .filter(c => c.id && c.simplified);

  const exactIndex = {}; // 整理後店名 -> 對到的客戶陣列（用來判斷「只對到一家」）
  customers.forEach(c => { (exactIndex[c.simplified] = exactIndex[c.simplified] || []).push(c); });

  const tempRows = readTempSheet_(tempSheet);
  const suspectedCol = TEMP_COLS.indexOf('疑似對應') + 1;
  const convertedCol = TEMP_COLS.indexOf('已轉正') + 1;

  const report = [];
  tempRows.forEach(row => {
    if (row.已轉正) return; // 已經轉正的不用再比對

    const simplified = simplifyPharmacyName_(row.店名);
    if (!simplified) {
      report.push({ id: row.id, name: row.店名, result: '對不到', detail: '店名整理後是空的' });
      return;
    }

    const exact = exactIndex[simplified] || [];
    if (exact.length === 1) {
      const detail = `${exact[0].id} ${exact[0].name}（完全相同）`;
      report.push({ id: row.id, name: row.店名, result: '自動填', detail });
      if (!dryRun) {
        tempSheet.getRange(row._row, convertedCol).setValue(exact[0].id);
        if (row.疑似對應) tempSheet.getRange(row._row, suspectedCol).setValue('');
      }
      return;
    }

    const suspects = [];
    if (exact.length > 1) {
      exact.forEach(c => suspects.push(`${c.id} ${c.name}（完全相同，對到多家）`));
    } else {
      // 「差1字」只在兩邊整理後都至少3個字才算，避免短店名（如「森康」）隨便差1字就對到一大堆不相干的店
      const allowOneCharDiff = simplified.length >= 3;
      customers.forEach(c => {
        if (c.simplified.indexOf(simplified) >= 0 || simplified.indexOf(c.simplified) >= 0) {
          suspects.push(`${c.id} ${c.name}（包含關係）`);
        } else if (allowOneCharDiff && c.simplified.length >= 3 && isOneCharDiff_(simplified, c.simplified)) {
          suspects.push(`${c.id} ${c.name}（差1字）`);
        }
      });
    }

    if (suspects.length > 2) {
      // 對到3家以上視為太模糊，不寫「疑似對應」，直接當對不到，避免累積一堆雜訊讓人工確認失去意義
      report.push({ id: row.id, name: row.店名, result: '對不到', detail: `太模糊，對到 ${suspects.length} 家：${suspects.join('；')}` });
    } else if (suspects.length) {
      report.push({ id: row.id, name: row.店名, result: '問我', detail: suspects.join('；') });
      if (!dryRun && !row.疑似對應) {
        tempSheet.getRange(row._row, suspectedCol).setValue(suspects.join('；'));
      }
    } else {
      report.push({ id: row.id, name: row.店名, result: '對不到', detail: '' });
    }
  });

  report.forEach(r => Logger.log(`[${r.result}] ${r.id} ${r.name}${r.detail ? ' → ' + r.detail : ''}`));
  Logger.log(
    `共 ${report.length} 家未轉正店家，自動填 ${report.filter(r => r.result === '自動填').length} 家、`
    + `問我 ${report.filter(r => r.result === '問我').length} 家、對不到 ${report.filter(r => r.result === '對不到').length} 家`
  );
  return report;
}

// 只看結果、不寫入任何欄位——先跑這個檢查規則準不準
function dryRunTempPharmacyNameMatch() {
  return matchTempPharmacyNames_(true);
}

// 確認規則沒問題後，真的寫入「已轉正」／「疑似對應」
function runTempPharmacyNameMatch() {
  return matchTempPharmacyNames_(false);
}

// 每日定時執行店名比對（2026-10-27）：排 06:30，比照 new-pharmacy-screening 的
// installDailyTrigger() 同一套模式，先清掉同名舊觸發器避免重複安裝。
// 必須在 Apps Script 編輯器手動執行這個函式一次才會生效（clasp run 在這個專案跑不起來，已知限制）。
function installDailyTempPharmacyMatchTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'runTempPharmacyNameMatch') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('runTempPharmacyNameMatch')
    .timeBased()
    .everyDays(1)
    .atHour(6)
    .nearMinute(30)
    .create();
  Logger.log('已安裝每日 06:30 執行 runTempPharmacyNameMatch 的觸發器。');
}
