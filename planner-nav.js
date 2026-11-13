// ============================================================
// SmartRoute 規劃流程 v2 — A1/A2/A3 共用主選單（docs/SPEC.md 6.1）。
//
// 2026-11-01 之前：planner.html／store-rules.html／followups.html 各自把整個 <nav> 寫死在
// HTML 裡，結果 A2/A3 連「客戶」倍數徽章、「切回舊版」連結都沒有，跟 A1 長得不一樣，改一處
// 也不會同步到另外兩處（已記在 docs/SPEC.md 待辦）。這支集中產生主選單內容跟徽章數字，
// 三頁只放一個空的 <nav id="app-nav"></nav> 容器，呼叫 window.SRNav.render({active, extraRight})
// 把內容灌進去，再呼叫 window.SRNav.loadBadges() 更新徽章——三頁用同一份 fetch/計算邏輯，
// 數字不會再有三頁對不起來的狀況。
//
// 只依賴 worker-url.js 的 window.SR_WORKER_URL，不依賴 planner-shared.js（它只有 store-rules.html／
// followups.html 載入，planner.html 沒有，這支要三頁都能用，所以自己包一個最小的 fetch）。
// ============================================================
(function () {
  // 階段3：目標最終順序是「昨日、今天、本週、本月、成果、客戶、紀錄、新店開發、待追蹤」，
  // 「昨日」頁還沒上線（A/B 寫入動作要等 GAS 部署＋收款單試算表ID才能用，見
  // docs/外勤模式_今日進度.md），先不排進主選單，只排其他已經上線的部分。
  const TABS = [
    { id: 'today', label: '今天', href: 'planner.html' },
    { id: 'week', label: '本週', href: 'weekly.html' },
    { id: 'month', label: '本月', href: 'monthly.html' },
    { id: 'recap', label: '成果', href: 'recap.html' },
    { id: 'customers', label: '客戶', href: 'customers.html', badge: 'badge-customers' },
    { id: 'records', label: '紀錄', href: 'records.html' },
    { id: 'new-store', label: '新店開發', href: 'funnel.html', badge: 'badge-new-store' },
  ];
  // 階段2：「店家規則」拿掉主選單入口，改成只能從 A8 藥局檔案抽屜的「店家規則」區塊點進去
  // （store-drawer.js 的「管理規則」連結，帶 ?store= 直接預選那家店）。store-rules.html 頁面
  // 本身沒拿掉，只是不再排進主選單。
  const MANAGE_TABS = [
    { id: 'followups', label: '待追蹤', href: 'followups.html', badge: 'badge-followups' },
  ];

  function tabHtml(t, active) {
    const badgeHtml = t.badge ? `<span id="${t.badge}" class="nav-badge" hidden></span>` : '';
    if (t.disabled) {
      return `<span class="nav-tab disabled" title="排在之後的階段才做">${t.label}${badgeHtml}</span>`;
    }
    return `<a class="nav-tab${t.id === active ? ' active' : ''}" href="${t.href}">${t.label}${badgeHtml}</a>`;
  }

  // extraRight：只有 planner.html 用到（規劃日期選擇器、找藥局輸入框），插在「切回舊版」連結前面。
  // 2026-11-03：767px 以下分頁清單收進漢堡選單（見 design-tokens.css 的 .nav-burger／.nav-tabs.open
  // RWD 規則），漢堡按鈕只在那個寬度才會用 CSS 顯示出來，1024px 以上完全不影響原本的單排顯示。
  function render({ active, extraRight }) {
    const container = document.getElementById('app-nav');
    if (!container) return;
    container.innerHTML = `
      <span class="nav-brand">SmartRoute</span>
      <button type="button" class="nav-burger" id="nav-burger" aria-label="開啟導覽選單" aria-expanded="false" aria-controls="nav-tabs">☰</button>
      <div class="nav-tabs" id="nav-tabs">
        ${TABS.map(t => tabHtml(t, active)).join('')}
        <div class="nav-divider"></div>
        <span class="nav-manage-label">管理</span>
        ${MANAGE_TABS.map(t => tabHtml(t, active)).join('')}
      </div>
      <div class="nav-right">
        ${extraRight || ''}
        <a class="nav-manage-link" href="index.html" title="切回舊版月曆/今日清單畫面">切回舊版</a>
      </div>
    `;
    const burger = document.getElementById('nav-burger');
    const tabs = document.getElementById('nav-tabs');
    burger.addEventListener('click', () => {
      const open = tabs.classList.toggle('open');
      burger.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  }

  function setBadgeEl(id, n) {
    const el = document.getElementById(id);
    if (!el) return;
    if (n > 0) { el.textContent = n; el.hidden = false; } else { el.hidden = true; }
  }

  async function apiGet(path) {
    try {
      const r = await fetch(window.SR_WORKER_URL + path);
      if (!r.ok) return null;
      return await r.json();
    } catch (e) { return null; }
  }

  // 客戶／新店開發徽章來自 /api/plan，待追蹤來自 /api/followups——三頁都呼叫這支，保證數字一致。
  async function loadBadges() {
    const [planData, followupsData] = await Promise.all([
      apiGet('/api/plan'),
      apiGet('/api/followups'),
    ]);
    setBadgeEl('badge-customers', planData?.badges?.customers || 0);
    setBadgeEl('badge-new-store', planData?.badges?.newStoreStuck || 0);
    setBadgeEl('badge-followups', followupsData?.badges?.followupsDueSoon || 0);
  }

  window.SRNav = { render, loadBadges };
})();
