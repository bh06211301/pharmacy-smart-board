// ============================================================
// SmartRoute 規劃流程 v2 — 評分與規則參數集中設定檔
// docs/SPEC.md 第 4 節。第 2 階段實際使用一週後要調整，只改這個檔案，不要改 worker.js 的計算邏輯本體。
// ============================================================

export const PLANNER_CONFIG = {
  // 4.1 各階段建議回訪間隔（天）。新店用「目前階段」對照這裡；正式客戶固定用 defaultCustomerIntervalDays
  // （SPEC 的「建議間隔天數」客戶欄位第 1 階段還沒加，先全部套用這個預設值）
  stageIntervalDays: {
    發現: 7,
    初訪後: 10,
    二訪後: 14,
    試賣中: 14,
  },

  // 4.2 間隔分公式（只給「新店開發」用）：間隔分 = min(倍數, ratioCap) * intervalScoreWeight
  // 正式客戶已改用下面的 tierIntervalDays + 倍數×月均排序（2026-10-27），不再套這個公式
  ratioCap: 2.0,
  intervalScoreWeight: 50,

  // 4.5 排除規則（2026-10-27 第二版：統一叫「不拜訪」，取消「其他通路」這個名字）：
  // 符合以下任一條，都不列入推薦清單、也不算進分級與門檻統計分母，但要能在 A1 手動加成「送貨」錨點
  // （錨點 UI 還沒做，這裡先只處理排除）：
  //   - AA 欄「負責人」＝老爸
  //   - F 欄「縣市」在 excludedCities 清單裡（目前只有新竹縣/新竹市；C130 艾美藥局本來就是新竹縣，這條已經會抓到，沒有另開例外清單）
  //   - C 欄「狀態」＝不拜訪（手動標記，目前 C135、C047 已填）
  // Z 欄「停用」有值（死客戶）另外處理，無條件排除，不在這份清單裡。
  excludedCities: ['新竹縣', '新竹市'],

  // 4.5 正式客戶分級門檻：大咖 → 首批後沒回購 → 潛力新店 → 冷淡 → 一般，依序檢查，符合就停。
  // 只用排除後剩下的客戶群計算（老爸/新竹/不拜訪/死客戶都不在分母裡）
  tierThresholds: {
    bigAccountMinMonths: 8,     // 大咖：近 12 個月有叫貨的月份數 >=
    potentialMaxCoopMonths: 6,  // 潛力新店／首批後沒回購：合作 <= 幾個月（同一個數字，兩條規則共用這個門檻）
    coldMinMonthsSinceOrder: 6, // 冷淡：距上次叫貨 > 幾個月
  },
  // 各級建議回訪間隔（天），決定倍數分母
  tierIntervalDays: {
    大咖: 21,
    潛力新店: 14,
    冷淡: 56,
    一般: 35,
  },

  // 2026-10-27 補：冷淡店很久沒接觸，倍數會一直往上加（例如良方 378/56=6.75倍），
  // 排序時壓過正在穩定叫貨的店——冷淡的店偶爾出現就好，不該衝到前段，所以倍數封頂。
  // 沒列在這裡的級別（大咖/潛力新店/一般）不設上限。
  tierRatioCap: {
    冷淡: 2.0,
  },

  // 2026-10-27 第二版：第四種提醒分兩種客人，看有沒有在「客戶合約」試算表（env.SHEET_CONTRACT）裡
  // 登記合約（合約狀態不是「終止」就算數，空白視為有效）：
  //   有合約：寄賣中(資料夾)總額 >= 切口金額 * consignmentReconcileMultiplier → 「該對帳」提醒
  //           （看金額不看天數，因為簽約店流量大，可能不到7個月就該對帳了）
  //   沒合約：維持看天數——訂單「紅單實體狀態」＝寄賣中(資料夾) 且訂單日期距今 >= consignmentCleanupMonths
  //           個月，彙整成一行「寄賣N張待整理」，排序分乘上 consignmentMultiplier
  // 兩種都限定在排除規則（isEligibleForTiering_）篩過的名單內，死客戶/老爸/新竹/不拜訪不檢查。
  consignmentCleanupMonths: 7,
  consignmentMultiplier: 1.5,      // 沒合約、寄賣滿N個月未整理：排序分 × 這個倍率
  consignmentReconcileMultiplier: 1.4, // 有合約：寄賣中總額 >= 切口金額 × 這個倍率 才提醒該對帳

  // 4.5 提醒門檻（顯示在推薦理由，不寫入待追蹤表）：
  //   首批後沒回購：併入分級判斷(見 tierThresholds)，合作 <= potentialMaxCoopMonths 個月、叫貨次數=1、
  //                 距那次 > noRepeatMinDaysSince 天 → tier 強制＝一般，不會被判成潛力新店
  //   叫貨下滑／叫貨回溫：跟分級是分開算的動量指標，大咖/潛力新店/一般都可能觸發（冷淡不標下滑，詳見 worker.js）
  alertThresholds: {
    noRepeatMinDaysSince: 60,     // 首批後沒回購：距唯一那次叫貨 > 幾天
    decliningMomentumBelow: 0.30, // 叫貨下滑：近3個月月化金額 < 全期月均 * 這個比例（且月均 >= 全體中位數、分級不是冷淡）
    reboundMomentumAbove: 2.00,   // 叫貨回溫：近3個月月化金額 > 全期月均 * 這個比例
  },

  // 4.5 待追蹤對正式客戶排序的影響（2026-10-27 第二版，取代舊的加分制）：
  //   到期日 <= 規劃日：不再加分，整筆移到 /api/plan 回傳的 anchors（來源標「待追蹤」），不參加排名
  //   還沒到期（含「下次經過」這種沒有具體日期的）：排序分 乘上 followupMultiplier，不是加法
  // 新店開發（篩選分頁）那邊完全不受影響，繼續用下面的 followupScore 加分制
  followupMultiplier: 1.3,

  // 4.2 待追蹤分：只給「新店開發」用，依距期限天數分級加分，總和不超過 followupScoreCap
  followupScore: {
    dueWithin3Days: 30,   // 指定日期前，剩 3 天內（含逾期）
    dueWithin7Days: 20,   // 剩 4～7 天
    dueLater: 10,         // 剩 8 天以上
    nextVisit: 10,        // 期限類型＝下次經過
  },
  followupScoreCap: 40,

  // 4.3 推薦清單篩選半徑（公里）。第 1 階段沒有錨點 UI，/api/plan 暫不套用，等第 2 階段 A1 做出來再接
  radiusKm: 2,

  // 4.4 顏色分級門檻（倍數）
  ratioColorThresholds: {
    veryLate: 1.5,  // 1.5 以上：很久了（深紅）
    late: 1.0,      // 1.0～1.5：該去了（淺紅）
    soon: 0.5,      // 0.5～1.0：快到了（淺灰）
    // 0.5 以下：還早（白）
  },
};
