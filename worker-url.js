// SmartRoute 共用：本機開發（localhost/127.0.0.1，或直接用 file:// 開檔，hostname 會是空字串）
// 自動連 wrangler dev，其他環境一律連正式 Worker。
// planner.html、store-drawer.js、planner-shared.js 都讀 window.SR_WORKER_URL，不要各自寫一份判斷，
// 也不需要部署前手動改網址。
window.SR_WORKER_URL = (['localhost', '127.0.0.1', ''].includes(location.hostname))
  ? 'http://127.0.0.1:8787'
  : 'https://still-meadow-0efd.bh06211301.workers.dev';
