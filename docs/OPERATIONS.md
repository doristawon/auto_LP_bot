# Operations Runbook

## 初次啟動

```bash
npm ci
cp .env.example .env
npm run once
npm start
```

先保持：

```env
DRY_RUN=true
ENABLE_LIVE_WRITES=false
ENABLE_AUTO_REDEPLOY=false
```

## Dashboard

### 安全操作摘要

本手冊不記錄特定錢包的持倉、交易雜湊、區塊掃描起點或實盤金額。每個錢包的 state 與 ledger 使用獨立路徑；請透過本機 Dashboard 與鏈上 explorer 核對目前狀態。

Dashboard 預設網址：`http://127.0.0.1:8787`。若本機埠被佔用，使用 `.env` 的 `DASHBOARD_PORT` 更新網址。
中控台介面使用繁體中文，功能分頁如下：

- **總覽**：資產價值、損益、LP 部位、執行狀態與安全閘門。
- **錢包與 RPC**：匯入助記詞／私鑰／唯讀地址，切換錢包並輸入 Robinhood RPC。
- **池子監控與 APR**：列出 Fables 池、TVL、24 小時成交量／手續費、池級 APR 與監控清單。
- **LP 部位與區間檢查**：查看部位、區間外狀態與再平衡資格。
- **分數即時模擬**：獨立顯示分數基準、估算增量、每日拆分及最近模擬時間。
- **帳務與事件紀錄**：手動現金流調整及交易／帳務事件。

APR 更新、區間檢查與分數模擬可分別在各自分頁設定，設定保存在本機 `data/dashboard-settings.json`，適用於所有錢包。預設 APR 更新為 60 秒、區間檢查為 300 秒、分數模擬為 15 秒；各自允許範圍會顯示在欄位旁。

池子分頁的「OOR 後再投入模式」可選擇自動挑選最高有效 APR 池，或用關鍵字搜尋後從 APR 排序下拉選單指定池。自動模式只接受新鮮 APR、未暫停且 TVL 至少 `APR_POOL_MIN_TVL_USD`（預設 30,000 美元）的候選池。目前跨池實盤缺少提領前的完整兌幣後存入模擬，因此會在提領前安全阻擋並保留原 LP；預演的資金範圍限於來源與目的池交易對及提領預估，不包含無關代幣。既有 LP 仍在區間內時，同池補倉可直接存入錢包中的交易對餘額；若依下方設定明確開啟單池換幣，且完整順序模擬通過，才會換幣後補倉。資產比例不符、費用超限或 Gas 保留不足時，餘額會留在錢包。

設定 `PERSIST_RUNTIME_CREDENTIALS=true` 後，成功驗證的自訂 RPC 與目前錢包私鑰／地址會原子寫入本機 `.env`，並將檔案 ACL 限定為目前使用者、SYSTEM 與系統管理員；`.env` 必須維持 Git 忽略。助記詞不會保存，僅在匯入時推導並保存私鑰。API 與日誌不回傳憑證。匯入／切換錢包會強制預演、關閉鏈上寫入與自動重新部署，並暫停執行；每次程序重啟也都會保持暫停，需確認啟動條件後按下大按鈕。每個錢包使用獨立狀態與帳務紀錄。

自訂 RPC 會先驗證實際 `eth_chainId` 為 4663，並保留官方公開 RPC 作讀取備援。池級 APR 沿用 Fables 公開估算公式：過去 24 小時手續費 × 365 ÷ 目前 TVL；它不是此錢包的實際報酬。Fables 統計來源暫時無法使用時，RPC 的鏈上部位監控與帳務仍可讀取，但 APR 會留白，依 APR 選跨池再投入目標會 fail closed；官方 Points 與費用佐證也可能暫時不可用。

控制項：

- **重新整理**：重新讀取中控台資料。
- **立即掃描（不交易）**：掃描鏈上狀態與帳務，不會送出交易。
- **啟動自動平衡**：只有指定目標池、錢包掃描完成、RPC 健康且無復原流程時可啟動；實盤模式另需啟用鏈上寫入、簽署器及通過 runtime 驗證的原子化防護。選池不會自動啟動。
- **暫停自動平衡**：阻止新的再平衡，不會停止監控；已開始的資產移動流程會安全完成或進入復原狀態。
- **人工再平衡**：只對已區間外且符合既定政策的部位開放。

手動 rebalance 預設關閉：

```env
DASHBOARD_MANUAL_CONTROL_ENABLED=false
```

要進行 dry-run canary 或小額 live canary 時才顯式改成：

```env
DASHBOARD_MANUAL_CONTROL_ENABLED=true
```

Manual control **不能**繞過：

1. Absolute In-Range Hold
2. OOR hysteresis policy
3. wallet topology cooldown / topology revalidation
4. execution pause
5. hourly rate limit
6. live signer / guard / write gates
7. receipt-reconciled executor state machine

Dashboard 僅綁定 `127.0.0.1` 時不需要 `DASHBOARD_TOKEN`，符合本機部署用途。若 `DASHBOARD_HOST` 改成非 loopback 位址，才必須設定權杖。

## 區間內閒置餘額加倉

`AUTO_TOPUP_ENABLED=true` 會把目前唯一、仍在區間內的 LP 交易對閒置代幣投入原區間，保留 `AUTO_TOPUP_DUST_BPS` 零頭與 `AUTO_TOPUP_MIN_GAS_ETH` Gas。預設不換幣；若要處理比例不符的餘額，須另外設定 `AUTO_TOPUP_SWAP_ENABLED=true`、**單一** `AUTO_TOPUP_SWAP_POOL_ID` 及該池的 `AUTO_TOPUP_MAX_SWAP_PRICE_IMPACT_BPS`。一般再平衡仍受獨立的 `MAX_SWAP_PRICE_IMPACT_BPS` 限制。

同池 OOR 再平衡會在撤出舊 LP 前，透過 `eth_simulateV1` 預演 guarded 撤池、必要的授權與換幣、重新存入 tight 區間，並檢查 Gas 預算；任何預演失敗都保留舊 LP。`npm run preflight:oor` 可唯讀檢查目前唯一的 OOR 部位。`-- --diagnostic-max-bps=350` 只調整該次診斷的報價上限，**不會**改變實盤設定。若要為單一池設定獨立實盤上限，需同時指定 `OOR_REBALANCE_SWAP_POOL_ID` 與 `OOR_REBALANCE_MAX_SWAP_PRICE_IMPACT_BPS`；其他池仍使用 `MAX_SWAP_PRICE_IMPACT_BPS`。首次觀測到 OOR 後滿 `OOR_CONFIRM_DELAY_MIN` 分鐘，下一次成功讀取鏈上 Tick 時若仍在原 LP 區間外，才具備自動撤池資格；任何一次讀到回到區間內都會清除計時。複查受監控週期與 RPC 可用性影響，可能晚於 15 分鐘。

部分 Solady ERC20 將 ERC20→Permit2 授權固定為無限額，並拒絕 `approve(Permit2, ...)`。機器人只有在現有授權確為 `uint256.max` 且唯讀呼叫回傳 `Permit2AllowanceIsFixedAtInfinity()` 時才跳過該層重設；Permit2→Router 仍必須設定定額與有效期限。

執行 `npm run preflight:topup` 可唯讀預演目前唯一 LP 的授權、換幣、存入與模擬後 Tick。機器人會在任何交易前模擬完整順序；授權完成後再用最新池價與已上鏈的授權重跑「換幣→存入」模擬。任一步失敗即不送出換幣，退回不換幣加倉或記錄失敗。鏈上狀態仍可能在模擬與成交間改變；若換幣已成交而存入失敗，journal 進入 `recovery_required` 並暫停後續自動交易。

Points 全池歷史資料在背景分段回補；回補未追上鏈頭前，中控台只提供暫估分數，不標示為完整預測，且不延遲 LP 監控。

建議先跑 24 小時以上 dry-run，確認：

- pool / range / shares 與 Fables UI 一致
- OOR 判斷一致
- fee accrual 有增量
- gas 與 lifecycle tx 能入 ledger
- PnL baseline 沒有被外部轉帳污染
- Points estimate 與 leaderboard 趨勢同方向

## 外部存提

若在 BOT 外手動轉入/轉出 tracked asset，Dashboard 新增 cashflow adjustment：

- 存入：正數
- 提領：負數

否則 PnL 會把外部資金流誤認成投資收益/損失。

## Points 校準

分數頁會自動同步 Fables 已結算分數，以本錢包的 LP 存提、已領及可領費用校正待結算估算。官方資料暫時無法取得時，可手動填入備援分數；手動值不會覆蓋已同步的官方分數。

之後 Dashboard：

```text
推估總分 = 官方已結算分數 + 待結算估算
```

## RPC

如果 public RPC 出現 429 / timeout：

1. 把 managed RPC 放到 `RPC_URLS` 第一位。
2. public RPC 留最後一個做備援。
3. 若做歷史 fee backfill，使用 archive endpoint。
4. 不要把 `LOG_CHUNK_BLOCKS` 無限加大；遇錯誤 BOT 會自動切小 chunk。

## Emergency stop

Dashboard `Pause new execution` 會阻止新的 rebalance 開始，但不停監控與會計；若已有 capital-moving state machine 啟動，不會在 withdraw / swap / deposit 半途硬中斷，而是讓它完成或進入 `recovery_required`。

也可以直接停止 process/container；ledger 已落盤。
