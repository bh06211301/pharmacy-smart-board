// ============================================================
// SmartRoute 規劃流程 v2 — A8 藥局檔案抽屜（共用模組）
// docs/SPEC.md 5.4、docs/DESIGN.md 2.12。設計成跟主頁面無關的獨立模組：
// 任何頁面只要 <script src="store-drawer.js"> 掛進去，呼叫 window.StoreDrawer.open(id) 就能用，
// 不用重寫。跟主頁面的整合點（「加入今天」按鈕）用 duck typing 偵測 window.addAnchor／
// window.toggleCol2 是否存在，不存在就顯示提示文字，不會因為掛在別的頁面而整個壞掉。
//
// WORKER 網址判斷集中在 worker-url.js（window.SR_WORKER_URL），引用這個檔案的頁面都要先載入
// <script src="worker-url.js"></script>，本機/正式環境會自動判斷，不用手動改。
// ============================================================
(function () {
  const DRAWER_WORKER = window.SR_WORKER_URL;

  const RULE_TYPES = ['不拜訪日', '在店時段', '請款規則', '拜訪前先做', '其他提醒'];
  const RULE_ACTIONS = ['擋住', '提醒', '自動調整'];
  const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];
  const FOLLOWUP_WHO = ['我', '老爸', '藥師', '帳務', '篩選器'];
  const FOLLOWUP_DEADLINE_TYPE = ['下次經過', '指定日期前'];

  let currentId = null;
  let currentData = null;
  let styleInjected = false;

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // 2026-10-28：任何會寫入資料的按鈕都要經過這裡——按下立刻 disabled + 改文字，避免使用者看不到
  // 反應連點好幾次（實測踩到：新增待追蹤連點5次，因為按鈕沒變化，以為沒反應，結果建了5筆一樣的資料）。
  // disabled 本身就擋住了「同一顆按鈕」的重複點擊；失敗時要把按鈕還原成原狀＋跳錯誤訊息，
  // 成功時大多數呼叫端會整個重繪把這顆按鈕換掉，不用特別還原。
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
      // 成功或失敗都還原：大部分情況 refresh() 會把 panel.innerHTML 整個換掉（還原一個已經
      // 不在畫面上的元素沒有影響），但像「加入今天」這種按鈕本身不會因為成功而被重繪，
      // 不還原就會卡在「新增中…」disabled 狀態出不來。
      btn.disabled = false;
      btn.textContent = originalLabel;
    }
  }

  // 請求ID：同一次使用者操作只產生一次，隨 POST 一起送出，後端（PlannerActions.js）用這個
  // 判斷是不是同一筆請求重送，不要真的寫兩次——雖然前端已經用 disabled 擋住同一顆按鈕的重複點擊，
  // 這個是多一層保險（例如網路重送這種前端攔不到的情況）。
  function genRequestId_() {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID();
    return 'r' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
  }

  // 簡短提示（「已新增」），2秒後自動消失，讓使用者確實知道寫入成功了，不用只靠清單有沒有變化去猜。
  function toast(msg) {
    const el2 = document.createElement('div');
    el2.className = 'sr-toast';
    el2.textContent = msg;
    document.body.appendChild(el2);
    setTimeout(() => el2.remove(), 2000);
  }
  function el(html) {
    const d = document.createElement('div');
    d.innerHTML = html.trim();
    return d.firstElementChild;
  }
  // /api/store 內部平行打了好幾個資料源，其中「藥局每日異動追蹤」是外部 Google Apps Script
  // （SCREENING_API_URL），GAS 偶爾會很慢甚至長時間不回應，而且不受這個 Worker 控制。如果那個
  // fetch 掛著不動，await get(...) 會一路卡在「載入中…」看起來就像畫面凍結——2026-10-28 實際用
  // Playwright 點擊測過一次沒有重現真的凍結（約2~4秒就載入完成），但沒辦法排除外部服務偶爾真的
  // 很慢的情況，所以還是加逾時，寧可明確顯示「逾時」也不要無限期卡住看起來像壞掉。
  const FETCH_TIMEOUT_MS = 15000;
  async function fetchWithTimeout_(url, opts) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      return await fetch(url, { ...opts, signal: controller.signal });
    } catch (e) {
      if (e.name === 'AbortError') throw new Error(`逾時（超過 ${FETCH_TIMEOUT_MS / 1000} 秒未回應）`);
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
  async function get(path) {
    const r = await fetchWithTimeout_(DRAWER_WORKER + path);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }
  async function post(path, body) {
    const r = await fetchWithTimeout_(DRAWER_WORKER + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { data = {}; }
    if (!r.ok || data.error) throw new Error(data.error || ('HTTP ' + r.status));
    return data;
  }

  // ---------- 樣式（用 design-tokens.css 的 --sr-* 變數，跟主頁面共用同一套token，不寫死色碼） ----------
  function injectStyles() {
    if (styleInjected) return;
    styleInjected = true;
    const style = document.createElement('style');
    style.textContent = `
      .sr-drawer-overlay { position: fixed; inset: 0; z-index: 9000; display: flex; justify-content: flex-end; }
      .sr-drawer-backdrop { position: absolute; inset: 0; background: rgba(0,0,0,0.08); }
      .sr-drawer-panel {
        position: relative; width: var(--sr-drawer-w); max-width: 100vw; height: 100%;
        background: var(--sr-bg); border-left: 2px solid var(--sr-ink); overflow-y: auto;
        font-family: var(--sr-font); color: var(--sr-ink); font-size: var(--sr-text-base);
      }
      .sr-drawer-close {
        position: absolute; top: 8px; right: 8px; width: 32px; height: 32px; display: flex;
        align-items: center; justify-content: center; background: none; border: none;
        color: var(--sr-ink-3); cursor: pointer; font-size: 16px; z-index: 1;
      }
      .sr-drawer-close:hover { background: var(--sr-bg-subtle); border-radius: var(--sr-radius-sm); }
      .sr-drawer-header { padding: var(--sr-space-8); border-bottom: 1px solid var(--sr-line); }
      .sr-drawer-title-row { display: flex; align-items: center; gap: var(--sr-space-4); flex-wrap: wrap; }
      .sr-drawer-name { font-size: var(--sr-text-2xl); font-weight: var(--sr-weight-bold); }
      .sr-drawer-stage { background: var(--sr-ink); color: var(--sr-on-dark); font-size: var(--sr-text-xs); padding: 2px 10px; border-radius: var(--sr-radius-sm); }
      .sr-drawer-meta { font-size: var(--sr-text-sm); color: var(--sr-ink-2); margin-top: var(--sr-space-2); }
      .sr-drawer-actions { display: flex; gap: var(--sr-space-4); margin-top: var(--sr-space-6); flex-wrap: wrap; }
      .sr-btn { height: var(--sr-btn-h); padding: 0 var(--sr-space-6); border-radius: var(--sr-radius-md); font-size: var(--sr-text-sm); font-weight: var(--sr-weight-bold); cursor: pointer; font-family: var(--sr-font); }
      .sr-btn-primary { background: var(--sr-primary); border: none; color: var(--sr-on-dark); }
      .sr-btn-primary:hover { background: var(--sr-primary-hover); }
      .sr-btn-secondary { background: var(--sr-bg); border: 1px solid var(--sr-ink); color: var(--sr-ink); }
      .sr-btn-secondary:hover { background: var(--sr-bg-subtle); }
      .sr-btn-tertiary { background: var(--sr-bg); border: 1px solid var(--sr-line); color: var(--sr-ink-2); }
      .sr-btn-tertiary:disabled { color: var(--sr-ink-3); cursor: not-allowed; }
      .sr-btn-sm { height: var(--sr-btn-h-sm); padding: 0 var(--sr-space-5); border-radius: var(--sr-radius-md); font-size: var(--sr-text-xs); font-weight: var(--sr-weight-bold); cursor: pointer; font-family: var(--sr-font); background: var(--sr-bg); border: 1px solid var(--sr-ink); color: var(--sr-ink); }
      .sr-btn-sm:hover { background: var(--sr-bg-subtle); }
      .sr-section { padding: var(--sr-space-7) var(--sr-space-8); border-bottom: 1px solid var(--sr-line-soft); }
      .sr-section-title { font-size: var(--sr-text-lg); font-weight: var(--sr-weight-bold); margin-bottom: var(--sr-space-5); display: flex; align-items: center; justify-content: space-between; }
      .sr-empty { font-size: var(--sr-text-sm); color: var(--sr-ink-3); border: 1px dashed var(--sr-line-dashed); border-radius: var(--sr-radius-md); padding: var(--sr-space-5); text-align: center; }
      .sr-tiering-badges { display: flex; gap: var(--sr-space-2); flex-wrap: wrap; margin-bottom: var(--sr-space-4); }
      .sr-badge-tier { background: var(--sr-ink); color: var(--sr-on-dark); font-size: var(--sr-text-xs); padding: 2px 9px; border-radius: var(--sr-radius-sm); font-weight: var(--sr-weight-bold); }
      .sr-badge-alert { background: var(--sr-danger-tint); color: var(--sr-danger); font-size: var(--sr-text-xs); padding: 2px 9px; border-radius: var(--sr-radius-sm); font-weight: var(--sr-weight-bold); }
      .sr-badge-consignment { background: var(--sr-danger-tint); color: var(--sr-danger); font-size: var(--sr-text-xs); padding: 2px 9px; border-radius: var(--sr-radius-sm); font-weight: var(--sr-weight-bold); }
      .sr-tiering-stats { display: flex; gap: var(--sr-space-8); margin-bottom: var(--sr-space-3); }
      .sr-stat-label { font-size: var(--sr-text-2xs); color: var(--sr-ink-3); }
      .sr-stat-value { font-size: var(--sr-text-lg); font-weight: var(--sr-weight-bold); font-variant-numeric: tabular-nums; }
      .sr-tiering-rule { font-size: var(--sr-text-xs); font-weight: var(--sr-weight-bold); color: var(--sr-danger); margin-top: var(--sr-space-3); }
      .sr-list-item { border: 1px solid var(--sr-line); border-radius: var(--sr-radius-md); padding: var(--sr-space-4) var(--sr-space-5); margin-bottom: var(--sr-space-3); display: flex; justify-content: space-between; align-items: start; gap: var(--sr-space-4); }
      .sr-list-item-main { font-size: var(--sr-text-sm); }
      .sr-list-item-sub { font-size: var(--sr-text-xs); color: var(--sr-ink-3); margin-top: 2px; }
      .sr-form { border: 1px dashed var(--sr-line-dashed); border-radius: var(--sr-radius-md); padding: var(--sr-space-5); margin-top: var(--sr-space-4); display: flex; flex-direction: column; gap: var(--sr-space-4); }
      .sr-form label { font-size: var(--sr-text-xs); color: var(--sr-ink-2); display: block; margin-bottom: 2px; }
      .sr-form input, .sr-form select { width: 100%; height: var(--sr-input-h); border: 1px solid var(--sr-line); border-radius: var(--sr-radius-md); padding: 0 var(--sr-space-4); font-size: var(--sr-text-sm); font-family: var(--sr-font); box-sizing: border-box; }
      .sr-form-row2 { display: grid; grid-template-columns: 1fr 1fr; gap: var(--sr-space-4); }
      .sr-form-actions { display: flex; gap: var(--sr-space-3); }
      .sr-visit-item, .sr-order-item { padding: var(--sr-space-3) 0; border-bottom: 1px solid var(--sr-line-row); font-size: var(--sr-text-sm); }
      .sr-visit-date { font-weight: var(--sr-weight-bold); }
      .sr-order-bars { display: flex; align-items: flex-end; gap: 4px; height: 60px; margin-bottom: var(--sr-space-4); }
      .sr-order-bar-col { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 2px; }
      .sr-order-bar { width: 100%; background: var(--sr-ink); border-radius: 2px 2px 0 0; }
      .sr-order-bar-label { font-size: 9px; color: var(--sr-ink-3); }
      .sr-toast {
        position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%); z-index: 9999;
        background: var(--sr-ink); color: var(--sr-on-dark); font-size: var(--sr-text-sm);
        padding: 10px 20px; border-radius: var(--sr-radius-md); font-family: var(--sr-font);
      }
    `;
    document.head.appendChild(style);
  }

  function close() {
    const root = document.getElementById('sr-drawer-root');
    if (root) root.remove();
    document.removeEventListener('keydown', onKeydown);
  }
  function onKeydown(e) { if (e.key === 'Escape') close(); }

  async function open(id) {
    injectStyles();
    close();
    currentId = id;
    const root = el(`<div id="sr-drawer-root" class="sr-drawer-overlay">
      <div class="sr-drawer-backdrop"></div>
      <div class="sr-drawer-panel"><div class="sr-section"><div class="sr-empty">載入中…</div></div></div>
    </div>`);
    document.body.appendChild(root);
    root.querySelector('.sr-drawer-backdrop').addEventListener('click', close);
    document.addEventListener('keydown', onKeydown);
    // 委派在 root 上：panel.innerHTML 之後會整塊換掉很多次（每次 refresh/renderDrawer），
    // root 本身不會被取代，監聽只要掛一次就能一直吃到裡面動態產生的按鈕，不用每次重新綁定，
    // 也不會再有「把店代號/電話號碼拼進 onclick="..."字串」這種截斷屬性的風險（2026-10-28 修）。
    root.addEventListener('click', (e) => {
      const t = e.target.closest('[data-action]');
      if (!t) return;
      const action = t.dataset.action;
      if (action === 'close') close();
      else if (action === 'add-today') addToday(t, t.dataset.kind);
      else if (action === 'call-phone' && t.dataset.phone) window.open('tel:' + t.dataset.phone);
      else if (action === 'toggle-followup-form') toggleFollowupForm();
      else if (action === 'submit-followup') submitFollowup(t);
      else if (action === 'resolve-followup') resolveFollowup(t, t.dataset.id);
      else if (action === 'toggle-rule-form') toggleRuleForm();
      else if (action === 'submit-rule') submitRule(t);
      else if (action === 'gen-briefing') genBriefing();
    });
    root.addEventListener('change', (e) => {
      const t = e.target.closest('[data-action]');
      if (!t) return;
      if (t.dataset.action === 'followup-deadline-type-change') onFollowupDeadlineTypeChange();
      else if (t.dataset.action === 'rule-type-change') onRuleTypeChange();
    });

    try {
      const data = await get('/api/store?id=' + encodeURIComponent(id));
      currentData = data;
      renderDrawer(data);
    } catch (e) {
      const panel = root.querySelector('.sr-drawer-panel');
      panel.innerHTML = `<button class="sr-drawer-close" data-action="close">✕</button>
        <div class="sr-section"><div class="sr-empty">載入失敗：${escapeHtml(e.message)}</div></div>`;
    }
  }

  // ---------- 分級與寄賣（今天新加的區塊：分級、淨額月均、三種提醒、寄賣或簽約對帳狀態） ----------
  function tieringBlockHtml(data) {
    const t = data.tiering;
    if (!t) {
      return `<div class="sr-section">
        <div class="sr-section-title">分級與寄賣</div>
        <div class="sr-empty">不列入分級（${escapeHtml(data.excludeReason || '排除規則')}）</div>
      </div>`;
    }
    const consignmentBadge = t.consignmentText ? `<span class="sr-badge-consignment">${escapeHtml(t.consignmentText)}</span>` : '';
    const ratioLine = t.daysSince === null
      ? '從未拜訪也從未叫貨，倍數固定 1.0'
      : `${t.daysSince} / ${t.intervalDays} 天 = ${t.rawRatio} 倍${t.ratio !== t.rawRatio ? `（封頂算 ${t.ratio}）` : ''}`;
    return `<div class="sr-section">
      <div class="sr-section-title">分級與寄賣</div>
      <div class="sr-tiering-badges">
        <span class="sr-badge-tier">${escapeHtml(t.tier)}</span>
        ${t.alert ? `<span class="sr-badge-alert">${escapeHtml(t.alert)}</span>` : ''}
        ${consignmentBadge}
        ${t.isContracted ? `<span class="sr-badge-tier">簽約店・切口 $${t.contractAmount.toLocaleString()}</span>` : ''}
      </div>
      <div class="sr-tiering-stats">
        <div><div class="sr-stat-label">月均叫貨（淨額）</div><div class="sr-stat-value">$${Math.round(t.avgMonthly).toLocaleString()}</div></div>
        <div><div class="sr-stat-label">寄賣中總額</div><div class="sr-stat-value">$${t.consignmentAllTotal.toLocaleString()}</div></div>
      </div>
      <div style="font-size:var(--sr-text-sm);color:var(--sr-ink-2)">${escapeHtml(ratioLine)}</div>
      ${t.ruleStatus?.rules?.length ? `<div class="sr-tiering-rule">規則：${escapeHtml(t.ruleStatus.rules.join('、'))}</div>` : ''}
    </div>`;
  }

  // ---------- 待追蹤（可勾選完成、可新增） ----------
  function followupsBlockHtml(data) {
    const items = data.followups || [];
    return `<div class="sr-section">
      <div class="sr-section-title">待追蹤<button class="sr-btn-sm" data-action="toggle-followup-form">＋新增</button></div>
      <div id="sr-followups-list">${items.length
        ? items.map(f => `<div class="sr-list-item">
            <div>
              <div class="sr-list-item-main">${escapeHtml(f.item)}</div>
              <div class="sr-list-item-sub">誰交代：${escapeHtml(f.who)}　${f.deadlineType === '指定日期前' && f.deadline ? '期限：' + escapeHtml(f.deadline) : '下次經過'}</div>
            </div>
            <button class="sr-btn-sm" data-action="resolve-followup" data-id="${escapeHtml(f.followupId)}">完成</button>
          </div>`).join('')
        : '<div class="sr-empty">目前沒有待追蹤事項</div>'}
      </div>
      <div id="sr-followup-form-root"></div>
    </div>`;
  }
  function toggleFollowupForm() {
    const root = document.getElementById('sr-followup-form-root');
    if (root.innerHTML) { root.innerHTML = ''; return; }
    root.innerHTML = `<div class="sr-form">
      <div><label>事項（必填）</label><input id="sr-f-item" type="text" placeholder="例：收9月貨款"></div>
      <div class="sr-form-row2">
        <div><label>誰交代</label><select id="sr-f-who">${FOLLOWUP_WHO.map(w => `<option>${w}</option>`).join('')}</select></div>
        <div><label>期限類型</label><select id="sr-f-deadline-type" data-action="followup-deadline-type-change">${FOLLOWUP_DEADLINE_TYPE.map(w => `<option>${w}</option>`).join('')}</select></div>
      </div>
      <div id="sr-f-deadline-row" style="display:none"><label>期限</label><input id="sr-f-deadline" type="date"></div>
      <div class="sr-form-actions">
        <button class="sr-btn sr-btn-primary" data-action="submit-followup">新增</button>
        <button class="sr-btn sr-btn-tertiary" data-action="toggle-followup-form">取消</button>
      </div>
    </div>`;
  }
  function onFollowupDeadlineTypeChange() {
    const v = document.getElementById('sr-f-deadline-type').value;
    document.getElementById('sr-f-deadline-row').style.display = v === '指定日期前' ? '' : 'none';
  }
  async function submitFollowup(btn) {
    const item = document.getElementById('sr-f-item').value.trim();
    if (!item) { alert('事項不能空白'); return; }
    const who = document.getElementById('sr-f-who').value;
    const deadlineType = document.getElementById('sr-f-deadline-type').value;
    const deadline = deadlineType === '指定日期前' ? document.getElementById('sr-f-deadline').value : '';
    const requestId = genRequestId_();
    await withBusy(btn, '新增中…', async () => {
      await post('/api/followups', { storeId: currentId, item, who, deadlineType, deadline, requestId });
      toast('已新增');
      await refresh();
    });
  }
  async function resolveFollowup(btn, followupId) {
    await withBusy(btn, '結案中…', async () => {
      await post('/api/followups', { resolve: true, followupId, resolvedFrom: 'A8藥局檔案手動結案' });
      toast('已結案');
      await refresh();
    });
  }

  // ---------- 店家規則（可新增） ----------
  function rulesBlockHtml(data) {
    const items = data.rules || [];
    return `<div class="sr-section">
      <div class="sr-section-title">店家規則<button class="sr-btn-sm" data-action="toggle-rule-form">＋新增</button></div>
      <div id="sr-rules-list">${items.length
        ? items.map(r => `<div class="sr-list-item">
            <div>
              <div class="sr-list-item-main">${escapeHtml(r.ruleType)}（${escapeHtml(r.action)}）</div>
              <div class="sr-list-item-sub">${escapeHtml(r.note || '')}${r.weekdays ? '　星期：' + escapeHtml(r.weekdays) : ''}${r.monthDays ? '　每月：' + escapeHtml(r.monthDays) : ''}</div>
            </div>
          </div>`).join('')
        : '<div class="sr-empty">目前沒有店家規則</div>'}
      </div>
      <div id="sr-rule-form-root"></div>
    </div>`;
  }
  function toggleRuleForm() {
    const root = document.getElementById('sr-rule-form-root');
    if (root.innerHTML) { root.innerHTML = ''; return; }
    root.innerHTML = `<div class="sr-form">
      <div class="sr-form-row2">
        <div><label>規則類型</label><select id="sr-r-type" data-action="rule-type-change">${RULE_TYPES.map(w => `<option>${w}</option>`).join('')}</select></div>
        <div><label>排程處理</label><select id="sr-r-action">${RULE_ACTIONS.map(w => `<option>${w}</option>`).join('')}</select></div>
      </div>
      <div id="sr-r-weekdays-row" style="display:none">
        <label>星期（可多選）</label>
        <div style="display:flex;gap:6px;flex-wrap:wrap">${WEEKDAYS.map(w => `<label style="display:flex;align-items:center;gap:2px;width:auto;font-size:var(--sr-text-xs)"><input type="checkbox" value="${w}" class="sr-r-weekday-cb" style="width:auto;height:auto">${w}</label>`).join('')}</div>
      </div>
      <div id="sr-r-monthdays-row" style="display:none"><label>每月日期（格式 起-迄，例如 28-31）</label><input id="sr-r-monthdays" type="text" placeholder="28-31"></div>
      <div id="sr-r-time-row" style="display:none" class="sr-form-row2">
        <div><label>時段起</label><input id="sr-r-timefrom" type="time"></div>
        <div><label>時段迄</label><input id="sr-r-timeto" type="time"></div>
      </div>
      <div><label>說明</label><input id="sr-r-note" type="text" placeholder="例：林藥師週一公休"></div>
      <div class="sr-form-actions">
        <button class="sr-btn sr-btn-primary" data-action="submit-rule">新增</button>
        <button class="sr-btn sr-btn-tertiary" data-action="toggle-rule-form">取消</button>
      </div>
    </div>`;
    onRuleTypeChange();
  }
  function onRuleTypeChange() {
    const v = document.getElementById('sr-r-type').value;
    document.getElementById('sr-r-weekdays-row').style.display = (v === '不拜訪日') ? '' : 'none';
    document.getElementById('sr-r-monthdays-row').style.display = (v === '不拜訪日' || v === '請款規則') ? '' : 'none';
    document.getElementById('sr-r-time-row').style.display = (v === '在店時段') ? '' : 'none';
  }
  async function submitRule(btn) {
    const ruleType = document.getElementById('sr-r-type').value;
    // 2026-10-31 修正：這個欄位（排程處理）原本送出時叫 action，跟 Worker 轉送 GAS 時用來選路由
    // 的 action（'addRule'）撞名，會被蓋掉送到 GAS 變成「排程處理不合法：addRule」而新增失敗
    // （實測踩到，已確認 GAS 端同步改成讀 scheduleAction，兩邊要一起改才會生效）。
    const scheduleAction = document.getElementById('sr-r-action').value;
    const weekdays = [...document.querySelectorAll('.sr-r-weekday-cb:checked')].map(c => c.value).join('');
    const monthDaysEl = document.getElementById('sr-r-monthdays');
    const monthDays = monthDaysEl ? monthDaysEl.value.trim() : '';
    const timeFromEl = document.getElementById('sr-r-timefrom');
    const timeFrom = timeFromEl ? timeFromEl.value : '';
    const timeToEl = document.getElementById('sr-r-timeto');
    const timeTo = timeToEl ? timeToEl.value : '';
    const note = document.getElementById('sr-r-note').value.trim();
    const requestId = genRequestId_();
    await withBusy(btn, '新增中…', async () => {
      await post('/api/rules', { storeId: currentId, ruleType, scheduleAction, weekdays, monthDays, timeFrom, timeTo, note, source: '自己', requestId });
      toast('已新增');
      await refresh();
    });
  }

  // ---------- 拜訪前簡報（沿用既有 /generate-script） ----------
  async function genBriefing() {
    const root = document.getElementById('sr-briefing-root');
    root.innerHTML = '<div class="sr-empty">產生中…</div>';
    try {
      const visitsData = await get('/visits/' + encodeURIComponent(currentId));
      const d = await post('/generate-script', {
        pharmacyId: currentId, pharmacyName: currentData.name, pharmacist: currentData.greeting || '',
        lastVisitDays: visitsData.lastVisitDays, recentVisits: visitsData.visits || [],
        visitPurpose: '例行拜訪', recentOrders: [],
      });
      root.innerHTML = `<div style="font-size:var(--sr-text-sm);line-height:1.8;white-space:pre-wrap">${escapeHtml(d.script || '（沒有產生內容）')}</div>`;
    } catch (e) {
      root.innerHTML = `<div class="sr-empty">產生失敗：${escapeHtml(e.message)}</div>`;
    }
  }

  // ---------- 拜訪紀錄（最近4筆，沿用既有 /visits/:id） ----------
  async function loadVisits(id) {
    const root = document.getElementById('sr-visits-root');
    try {
      const d = await get('/visits/' + encodeURIComponent(id));
      const visits = (d.visits || []).slice(0, 4);
      if (!visits.length) { root.innerHTML = '<div class="sr-empty">還沒有拜訪紀錄</div>'; return; }
      root.innerHTML = visits.map(v => `<div class="sr-visit-item">
        <span class="sr-visit-date">${escapeHtml(v.date)}</span>　${escapeHtml(v.purpose || '拜訪')}
        <div style="color:var(--sr-ink-2);margin-top:2px">${escapeHtml(v.summary || v.content || '')}</div>
      </div>`).join('');
    } catch (e) {
      root.innerHTML = `<div class="sr-empty">載入失敗：${escapeHtml(e.message)}</div>`;
    }
  }

  // ---------- 進貨（近12個月長條＋常進品項，沿用既有 /pharmacy-profile） ----------
  // 2026-10-28 查到根本原因：長條圖原本讀「出貨明細」(/pharmacy-profile，SHEET_ORDER，用店名_備份比對)，
  // 跟評分(/api/plan、這個抽屜的「分級與寄賣」)讀的「訂單主檔」(SHEET_ORDER_MASTER，用店名欄位比對)是兩張
  // 完全不同的表，店家涵蓋範圍跟日期完整度都不保證一致——C133 永佳 2026/6/18 那筆 $32,270，評分讀得到
  // （tiering.consignmentAllTotal 已經證實撈得到這張單），出貨明細那邊卻讀不到。改成長條圖直接用
  // currentData.monthlyOrders（/api/store 用 orderData/returnOrderData 現算的，跟 tiering 同一份資料
  // 來源、同一個 planDate），不再另外打 /pharmacy-profile 的日期；常進品項維持用 /pharmacy-profile，
  // 因為訂單主檔沒有逐品項明細，只有出貨明細查得到，兩塊分開但各自跟對的資料源對齊。
  function monthlyOrdersChartHtml(monthlyOrders) {
    if (!monthlyOrders || !monthlyOrders.length) return '<div class="sr-empty">近12個月沒有叫貨紀錄</div>';
    const allZero = monthlyOrders.every(m => m.total === 0);
    if (allZero) return '<div class="sr-empty">近12個月沒有叫貨紀錄（訂單主檔查不到這家店近12個月的訂單）</div>';
    const maxTotal = Math.max(1, ...monthlyOrders.map(m => Math.max(0, m.total)));
    return `<div class="sr-order-bars">${monthlyOrders.map(m => {
      const label = m.key.slice(5, 7).replace(/^0/, '') + '月';
      const height = Math.round(Math.max(0, m.total) / maxTotal * 56);
      return `<div class="sr-order-bar-col">
        <div class="sr-order-bar" style="height:${height}px" title="${label}：$${m.total.toLocaleString()}（淨額，已扣退貨）"></div>
        <div class="sr-order-bar-label">${label}</div>
      </div>`;
    }).join('')}</div>`;
  }

  async function loadOrders(id) {
    const root = document.getElementById('sr-orders-root');
    const chartHtml = monthlyOrdersChartHtml(currentData?.monthlyOrders);
    try {
      const d = await get('/pharmacy-profile?pharmacy=' + encodeURIComponent(id));
      const orders = d.orders || [];
      const productTotals = {};
      orders.forEach(o => { productTotals[o.productName] = (productTotals[o.productName] || 0) + (o.qty || 0); });
      const topProducts = Object.entries(productTotals).sort((a, b) => b[1] - a[1]).slice(0, 5);

      root.innerHTML = `
        ${chartHtml}
        <div style="font-size:var(--sr-text-xs);color:var(--sr-ink-3);margin:var(--sr-space-4) 0">常進品項（不限近12個月，全部歷史紀錄，來自出貨明細）</div>
        ${topProducts.length
          ? topProducts.map(([name, qty]) => `<div class="sr-order-item">${escapeHtml(name)}　<span style="color:var(--sr-ink-2)">共 ${qty} 件</span></div>`).join('')
          : '<div class="sr-empty">還沒有出貨明細紀錄</div>'}
      `;
    } catch (e) {
      // 長條圖資料已經在 renderDrawer 時從 currentData 拿到了，/pharmacy-profile 失敗只影響「常進品項」那塊，
      // 不要把長條圖也一起蓋掉。
      root.innerHTML = `${chartHtml}<div class="sr-empty" style="margin-top:var(--sr-space-4)">常進品項載入失敗：${escapeHtml(e.message)}</div>`;
    }
  }

  // ---------- 加入今天（跟主頁面的整合點，duck typing） ----------
  async function addToday(btn, kind) {
    if (kind === 'anchor') {
      if (typeof window.addAnchor !== 'function') {
        alert('這個頁面沒有「今天」清單，無法加入（store-drawer.js 是共用模組，只有掛在 planner.html 這類有 addAnchor() 的頁面才能用這個按鈕）');
        return;
      }
      await withBusy(btn, '加入中…', async () => {
        await window.addAnchor({ id: currentId, name: currentData.name, source: '手動', item: '藥局檔案加入', deadline: null });
        toast('已加入今天一定要去');
      });
    } else {
      // 跟主頁面整合的另一個坑：planner.html 的 planData 是用 let 宣告的全域變數，
      // 這種宣告不會變成 window.planData（跟 function 宣告會變成 window.xxx 不一樣），
      // 要用 typeof 檢查裸變數名稱是否存在，不能寫 window.planData（永遠是 undefined，會誤判）。
      const pd = (typeof planData !== 'undefined') ? planData : null;
      if (typeof window.toggleCol2 !== 'function' || !pd?.recommended?.some(x => x.id === currentId)) {
        alert('這家店目前不在順路推薦清單裡（可能是已排除的店，或這個頁面沒有推薦清單）');
        return;
      }
      window.toggleCol2(currentId); // 純前端勾選，不寫入任何資料，不需要 busy 狀態
      toast('已加入今天順路清單');
    }
  }

  async function refresh() {
    try {
      const data = await get('/api/store?id=' + encodeURIComponent(currentId));
      currentData = data;
      renderDrawer(data);
    } catch (e) {
      alert('重新載入失敗：' + e.message);
    }
  }

  function renderDrawer(data) {
    const root = document.getElementById('sr-drawer-root');
    const panel = root.querySelector('.sr-drawer-panel');
    // 區域顯示「縣市＋行政區」（例如新北市鶯歌區），不是內部歸檔用的「實體資料夾」；
    // 「藥師：」顯示的是 L 欄「稱呼」（真人姓名），不是 K 欄「Key Man」（那欄實際存的是職稱，
    // 固定寫「藥師」兩個字，CLAUDE.md 早就記錄過這個欄名跟內容對不上的坑，2026-10-28 改回正確欄位）。
    const cityDistrict = [data.city, data.district].filter(Boolean).join('');
    panel.innerHTML = `
      <button class="sr-drawer-close" aria-label="關閉" data-action="close">✕</button>
      <div class="sr-drawer-header">
        <div class="sr-drawer-title-row">
          <span class="sr-drawer-name">${escapeHtml(data.name)}</span>
          ${data.stage ? `<span class="sr-drawer-stage">${escapeHtml(data.stage)}</span>` : ''}
        </div>
        <div class="sr-drawer-meta">${escapeHtml(data.id)}${cityDistrict ? '　' + escapeHtml(cityDistrict) : ''}${data.greeting ? '　藥師：' + escapeHtml(data.greeting) : ''}</div>
        <div class="sr-drawer-actions">
          <button class="sr-btn sr-btn-primary" data-action="add-today" data-kind="anchor">加入今天：一定要去</button>
          <button class="sr-btn sr-btn-secondary" data-action="add-today" data-kind="maybe">加入今天：順路</button>
          <button class="sr-btn sr-btn-tertiary" disabled title="排在之後的階段才做">延後</button>
          <button class="sr-btn sr-btn-tertiary" ${data.phone ? '' : 'disabled'} data-action="call-phone" data-phone="${escapeHtml(data.phone || '')}">打電話</button>
        </div>
      </div>
      <div class="sr-drawer-body">
        ${tieringBlockHtml(data)}
        ${followupsBlockHtml(data)}
        ${rulesBlockHtml(data)}
        <div class="sr-section">
          <div class="sr-section-title">拜訪前簡報</div>
          <div id="sr-briefing-root"><button class="sr-btn sr-btn-secondary" data-action="gen-briefing">產生話術</button></div>
        </div>
        <div class="sr-section">
          <div class="sr-section-title">拜訪紀錄（最近4筆）</div>
          <div id="sr-visits-root"><div class="sr-empty">載入中…</div></div>
        </div>
        <div class="sr-section">
          <div class="sr-section-title">進貨</div>
          <div id="sr-orders-root"><div class="sr-empty">載入中…</div></div>
        </div>
        <div class="sr-section" style="border-bottom:none">
          <div class="sr-section-title">漏斗歷程</div>
          <div style="font-size:var(--sr-text-sm);color:var(--sr-ink-2)">${data.type === 'new-store' ? escapeHtml(data.stage || '') : '正式客戶'}</div>
        </div>
      </div>
    `;
    loadVisits(data.id);
    loadOrders(data.id);
  }

  window.StoreDrawer = {
    open, close,
    _toggleFollowupForm: toggleFollowupForm,
    _onFollowupDeadlineTypeChange: onFollowupDeadlineTypeChange,
    _submitFollowup: submitFollowup,
    _resolveFollowup: resolveFollowup,
    _toggleRuleForm: toggleRuleForm,
    _onRuleTypeChange: onRuleTypeChange,
    _submitRule: submitRule,
    _genBriefing: genBriefing,
    _addToday: addToday,
  };
})();
