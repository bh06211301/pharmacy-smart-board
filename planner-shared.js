// ============================================================
// SmartRoute 規劃流程 v2 — A2/A3 共用的 fetch 函式（docs/SPEC.md 7.1：資料邏輯跟畫面分開，
// 頁面只負責顯示，不要各自寫一份 fetch）。
//
// WORKER 網址判斷集中在 worker-url.js（window.SR_WORKER_URL），引用這個檔案的頁面都要先載入
// <script src="worker-url.js"></script>，本機/正式環境會自動判斷，不用手動改、也不用三個檔案
// 各寫一份判斷邏輯。
// 密鑰（PLANNER_API_TOKEN）完全不在前端出現：寫入一律打這支 Worker 自己的端點（/api/rules、
// /api/followups），Worker 收到後才會代填 token 轉送給 GAS，前端的 post() 不用、也不會碰到密鑰。
//
// store-drawer.js、planner.html 目前各自有一份幾乎一樣的 get/post/withBusy/toast/escapeHtml
// （重複三份）。這次刻意不整併——使用者 2026-10-31 要求先不要動既有檔案，只記録成待辦（見
// docs/SPEC.md 第11節），之後要合併時這三份都要一起看。
// ============================================================
(function () {
  const WORKER = window.SR_WORKER_URL;

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  async function get(path) {
    const r = await fetch(WORKER + path);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }
  async function post(path, body) {
    const r = await fetch(WORKER + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { data = {}; }
    if (!r.ok || data.error) throw new Error(data.error || ('HTTP ' + r.status));
    return data;
  }

  // 任何會寫入資料的按鈕都要經過這裡——按下立刻 disabled + 改文字，避免連點好幾次送出重複請求
  // （planner.html／store-drawer.js 2026-10-28 都踩過這個坑，同一套防呆搬過來）。
  async function withBusy(btn, busyLabel, fn) {
    if (!btn || btn.disabled) return;
    const originalLabel = btn.textContent;
    btn.disabled = true;
    btn.textContent = busyLabel;
    try {
      await fn();
    } catch (e) {
      alert('失敗：' + e.message);
    } finally {
      btn.disabled = false;
      btn.textContent = originalLabel;
    }
  }

  function toast(msg) {
    const el = document.createElement('div');
    el.className = 'sr-toast-shared';
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2000);
  }

  function genRequestId() {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID();
    return 'r' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
  }

  // 2026-11-01：店名搜尋下拉元件，從 followups.html 原本的 onStoreInput() 抽出來——
  // store-rules.html「＋新增規則」跟 followups.html「隨手新增」都是同一種互動（文字輸入→過濾→
  // 下拉候選→點選），資料來源不同（A2 只搜正式客戶，A3 含開發中新店），所以用 getStores() 由呼叫端
  // 決定要搜哪份清單，比對/渲染/點選這段共用一份。
  // 每次輸入都先呼叫 onPick(null)，讓呼叫端清掉上次選到的店（跟原本 onStoreInput() 行為一致：
  // 使用者一旦又開始打字，先前選到的店就該視為失效，不能讓舊的 pickedStore 殘留）。
  function bindStoreSearch({ input, results, getStores, onPick, renderLabel }) {
    function defaultLabel(s) { return `${escapeHtml(s.name)}（${escapeHtml(s.id)}）`; }
    function onInput() {
      const q = input.value.trim();
      onPick(null);
      if (!q) { results.hidden = true; results.innerHTML = ''; return; }
      const stores = getStores() || [];
      const matched = stores.filter(s => s.name.includes(q) || s.id.includes(q)).slice(0, 15);
      if (!matched.length) { results.hidden = true; results.innerHTML = ''; return; }
      results.hidden = false;
      results.innerHTML = matched.map(s => `<div class="quick-add-result-row" data-id="${escapeHtml(s.id)}">
        ${renderLabel ? renderLabel(s) : defaultLabel(s)}
      </div>`).join('');
      results.querySelectorAll('[data-id]').forEach(row => {
        row.addEventListener('click', () => {
          const s = matched.find(x => x.id === row.dataset.id);
          results.hidden = true;
          onPick(s);
        });
      });
    }
    input.addEventListener('input', onInput);
  }

  // 2026-11-01：店家依「市→區」分組，A2 左側清單在用，之後 A7 客戶總覽也要用，所以放這裡共用，
  // 不是只給 A2 用的一次性函式。只正規化「臺→台」——查過正式客戶資料表136家店，縣市/行政區兩欄
  // 都沒有空白（不用處理「缺區域」的例外），但「台北市」有29家、「臺北市」有2家（C129大鳥藥局、
  // C132天蓮藥局）混用同一個字的繁簡寫法，其他縣市沒有這個問題。這裡沿用 gas-backend/
  // VisitAppWebhook.js 的 normKey_() 已經在用的同一個正規化規則（臺→台），不是另外發明一套；
  // 原始資料本身使用者會自己去 AppSheet 改掉，這裡的正規化只是前端分組顯示用的防呆，長期都留著。
  function normalizeCity(city) {
    return String(city || '').replace(/臺/g, '台').trim();
  }

  // 回傳依「市→區」兩層分組的結構：市依家數由多到少排序（2026-11-02 使用者要求，同家數再依
  // 字母排序當決勝，避免排序不穩定），區維持字母排序不變（SPEC 待辦只提到市的順序）：
  // [{ city, count, districts: [{ district, count, stores }] }]
  function groupStoresByRegion(stores) {
    const cityMap = new Map();
    (stores || []).forEach(s => {
      const city = normalizeCity(s.city) || '（未分類）';
      const district = String(s.district || '').trim() || '（未分類）';
      if (!cityMap.has(city)) cityMap.set(city, new Map());
      const districtMap = cityMap.get(city);
      if (!districtMap.has(district)) districtMap.set(district, []);
      districtMap.get(district).push(s);
    });
    return [...cityMap.entries()]
      .map(([city, districtMap]) => {
        const districts = [...districtMap.entries()]
          .sort((a, b) => a[0].localeCompare(b[0], 'zh-Hant'))
          .map(([district, list]) => ({ district, count: list.length, stores: list }));
        const count = districts.reduce((sum, d) => sum + d.count, 0);
        return { city, count, districts };
      })
      .sort((a, b) => b.count - a.count || a.city.localeCompare(b.city, 'zh-Hant'));
  }

  // 待追蹤「期限」從 gviz 讀回來有兩種格式：Google Sheets 把那個欄位存成真正日期型別時是原始
  // gviz 字面值 "Date(2026,10,16)"（月份從0算，不是一般日期字串）；存成純文字則是一般的
  // "2026/11/16" 或 "2026-11-16"。worker.js 的 parseGvizDate() 處理過這個問題，但前端一直沒有
  // 對應的共用函式——2026-11-02 在 weekly.html 抓到這個 bug（右側清單日期排序/分組失敗），同一天
  // 發現 followups.html（A3）的「期限」欄也一直把 "Date(...)" 原始字串直接顯示給使用者看
  // （`<input type="date">` 編輯框也因此顯示空白，不是真的壞掉，只是值格式不對無法被 date input
  // 接受）。這支抽成共用函式，weekly.html／followups.html 都要用這份，不要各自處理一次。
  function gvizDateToIso(s) {
    if (!s) return null;
    const m = String(s).match(/^Date\((\d+),(\d+),(\d+)\)$/);
    if (m) return `${m[1]}-${String(Number(m[2]) + 1).padStart(2, '0')}-${m[3].padStart(2, '0')}`;
    const d = new Date(String(s).replace(/\//g, '-'));
    return isNaN(d) ? null : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  // 寄賣/簽約「該對帳」判斷，跟 planner.html 自己的同名函式邏輯刻意保持一致（故意複製，不是共用
  // 元件——planner.html 目前沒有載入 planner-shared.js，見檔頭註解「三份重複的 get/post/...」
  // 同一條待辦，之後整併 helper 時這裡要跟 planner.html 那份一起處理，不要只改一邊）。
  // weekly.html（A5）用這個算「還沒指定日期的請款」清單跟頂部色帶要不要觸發。
  function consignmentBadge(item) {
    if (item.isContracted) {
      const triggered = item.consignmentAllTotal >= item.contractAmount * 1.4;
      if (!triggered) return { html: '', triggered: false, sortValue: 0 };
      return {
        html: `<span class="badge-consignment due">該對帳：寄賣中 $${item.consignmentAllTotal.toLocaleString()} / 切口 $${item.contractAmount.toLocaleString()}</span>`,
        triggered: true, sortValue: 2, label: '該對帳', detail: `寄賣中 $${item.consignmentAllTotal.toLocaleString()} / 切口 $${item.contractAmount.toLocaleString()}`,
      };
    }
    if (item.consignmentStaleCount > 0) {
      return {
        html: `<span class="badge-consignment due">寄賣${item.consignmentStaleCount}張待整理，最久${item.consignmentStaleMaxMonths}個月</span>`,
        triggered: true, sortValue: 1, staleTotal: item.consignmentStaleTotal,
        label: '寄賣待整理', detail: `${item.consignmentStaleCount}張，最久${item.consignmentStaleMaxMonths}個月，共 $${item.consignmentStaleTotal.toLocaleString()}`,
      };
    }
    return { html: '', triggered: false, sortValue: 0 };
  }

  // 假日資料（holidays-{year}.json，手動年度更新，見 docs/SPEC.md 第11節待辦「每年7~8月更新
  // holidays JSON」）。多年份合併查詢用，結果快取在記憶體，同一頁重複呼叫不會重複 fetch。
  // weekly.html（A5）目前唯一的使用者，之後 A6（本月）要用同一份，不要再寫一次。
  const holidayCache_ = {};
  async function loadHolidays(years) {
    const merged = {};
    await Promise.all((years || []).map(async year => {
      if (!holidayCache_[year]) {
        try {
          const res = await fetch(`holidays-${year}.json`);
          holidayCache_[year] = res.ok ? await res.json() : {};
        } catch (e) { holidayCache_[year] = {}; }
      }
      Object.assign(merged, holidayCache_[year]);
    }));
    return merged;
  }

  // toast 的樣式獨立注入一次，不靠頁面自己的 <style> 區塊（A2/A3 都會用到）
  const style = document.createElement('style');
  style.textContent = `
    .sr-toast-shared {
      position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%); z-index: 9999;
      background: var(--sr-ink); color: var(--sr-on-dark); font-size: var(--sr-text-sm);
      padding: 10px 20px; border-radius: var(--sr-radius-md); font-family: var(--sr-font);
    }
  `;
  document.head.appendChild(style);

  window.PlannerAPI = { get, post, withBusy, toast, escapeHtml, genRequestId, bindStoreSearch, normalizeCity, groupStoresByRegion, consignmentBadge, loadHolidays, gvizDateToIso };
})();
