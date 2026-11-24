// 2026-11-24：field-v2.html 修 iOS Safari 輸入框聚焦自動放大頁面的問題——靜態檢查版本。
// 只讀檔案文字做字串/正則檢查，不開瀏覽器。確認：
// 1. viewport meta 沒有加 maximum-scale 或 user-scalable=no（不可用停用縮放的方式繞過）
// 2. 所有可聚焦輸入元件（textarea / input[type=text] / input[type=date]）的樣式規則
//    最小字體 >= 16px
// 執行：node tools/test-field-v2-input-zoom.mjs

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.join(__dirname, '..', 'field-v2.html'), 'utf8');

let pass = 0;
let fail = 0;

function assert(cond, label) {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.error(`✗ ${label}`);
  }
}

// ---- 1. viewport meta 不能停用縮放 ----
const viewportMatch = html.match(/<meta\s+name="viewport"[^>]*>/i);
assert(!!viewportMatch, 'viewport meta 標籤存在');
const viewportContent = viewportMatch ? viewportMatch[0] : '';
assert(!/maximum-scale/i.test(viewportContent), 'viewport 沒有 maximum-scale');
assert(!/user-scalable\s*=\s*no/i.test(viewportContent), 'viewport 沒有 user-scalable=no');

// 整份檔案也不該有 maximum-scale / user-scalable=no（避免藏在別的地方，例如 JS 動態改 viewport）
assert(!/maximum-scale/i.test(html), '整份檔案沒有 maximum-scale 字樣');
assert(!/user-scalable\s*=\s*no/i.test(html), '整份檔案沒有 user-scalable=no 字樣');

// ---- 2. 找出所有可聚焦輸入元件的 tag/type，逐一確認樣式規則字體 >= 16px ----
// field-v2.html 目前只有 input[type=text]、input[type=date]、textarea 三種可打字的輸入元件
// （checkbox/radio 不受 iOS 自動放大影響，select/contenteditable 這份檔案裡沒有用到）
const inputTagMatches = [...html.matchAll(/<(input|textarea|select)\b[^>]*>/gi)];
assert(inputTagMatches.length > 0, '檔案裡找得到 input/textarea/select 標籤');

const focusableTypes = new Set();
for (const m of inputTagMatches) {
  const tag = m[0];
  const tagName = m[1].toLowerCase();
  if (tagName === 'textarea' || tagName === 'select') {
    focusableTypes.add(tagName);
    continue;
  }
  // input：只關心會跳出鍵盤讓使用者打字的類型
  const typeMatch = tag.match(/type\s*=\s*["']?([a-z]+)["']?/i);
  const type = typeMatch ? typeMatch[1].toLowerCase() : 'text'; // 沒寫 type 預設是 text
  if (['text', 'date', 'number', 'email', 'tel', 'search', 'url', 'password'].includes(type)) {
    focusableTypes.add(`input[type=${type}]`);
  }
}
console.log('偵測到的可聚焦輸入元件種類：', [...focusableTypes].join('、'));

// 確認偵測到的種類跟目前實際用到的一致（textarea、input[type=text]、input[type=date]）
assert(focusableTypes.has('textarea'), '檔案裡有 textarea');
assert(focusableTypes.has('input[type=text]'), '檔案裡有 input[type=text]');
assert(focusableTypes.has('input[type=date]'), '檔案裡有 input[type=date]');
assert(!focusableTypes.has('select'), '確認目前沒有 select（若之後新增，這條測試會提醒要補字體規則）');

// ---- 3. 抓出 textarea, input[type=text], input[type=date] 那條樣式規則，確認 font-size >= 16px ----
const ruleMatch = html.match(/textarea,\s*input\[type=text\],\s*input\[type=date\]\s*\{([^}]*)\}/);
assert(!!ruleMatch, '找到 textarea/input[type=text]/input[type=date] 的共用樣式規則');

if (ruleMatch) {
  const ruleBody = ruleMatch[1];
  const fontSizeMatch = ruleBody.match(/font-size\s*:\s*([0-9.]+)px/);
  assert(!!fontSizeMatch, '該規則用固定 px 寫死 font-size（不是用可能 <16px 的 design token 變數）');
  if (fontSizeMatch) {
    const size = parseFloat(fontSizeMatch[1]);
    assert(size >= 16, `font-size ${size}px >= 16px`);
  }
}

// ---- 4. 確認這條規則沒有被 var(--sr-text-base) 等已知 <16px 的 token 覆蓋 ----
assert(
  !/textarea,\s*input\[type=text\],\s*input\[type=date\]\s*\{[^}]*var\(--sr-text-base\)/.test(html),
  '輸入框字體規則沒有改回用 --sr-text-base（該 token 目前是 14px，會導致 iOS 放大）'
);

console.log(`\n共 ${pass + fail} 筆斷言，通過 ${pass}，失敗 ${fail}`);
if (fail > 0) {
  process.exit(1);
}
