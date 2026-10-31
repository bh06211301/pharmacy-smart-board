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

  window.PlannerAPI = { get, post, withBusy, toast, escapeHtml, genRequestId };
})();
