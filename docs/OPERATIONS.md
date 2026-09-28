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

預設每 5 分鐘同輪掃描錢包餘額、LP 區間與全池鏈上狀態，並從 Fables HTTP 讀取 TVL 作為估值路徑權重。APR 只在區間外部位通過再平衡安全閘門後，從 Fables API 即時取得供選池；平時不定時更新，介面會標示上次樣本時間或留白。區間評估與分數模擬可分別在各自分頁設定，保存在本機 `data/dashboard-settings.json`。分數畫面的本地模擬預設每 15 秒更新，官方分數與錢包費用佐證最密每 5 分鐘重讀。

池子分頁的「OOR 後再投入模式」可選擇自動挑選最高有效 APR 池，或用關鍵字搜尋後從 APR 排序下拉選單指定池。自動模式只接受新鮮 APR、未暫停且 TVL 至少 `APR_POOL_MIN_TVL_USD`（預設 30,000 美元）的候選池。ERC20 跨池實盤會在提領前用 `eth_simulateV1` 順序模擬 guarded 撤池、路由與比例換幣、Tight 存入；各筆報價成本及 slippage 預留，依該筆換幣金額占總再投入資產加權後，不得超過 `CROSS_POOL_MAX_SWAP_PRICE_IMPACT_BPS`（預設 350 bps）。候選不通過時嘗試下一池，皆不通過則在原池重建。原生 ETH 池目前仍因缺少可驗證的原生幣路由及存入流程而跳過，清單明確標示。每池約 10 美元換幣成本只在手動要求時由 Quoter 更新，不是實際交易報價。預演資金範圍限於來源與目的池交易對及提領預估，不包含無關代幣。既有 LP 仍在區間內時，同池補倉可直接存入錢包中的交易對餘額；若依下方設定明確開啟單池換幣，且完整順序模擬通過，才會換幣後補倉。資產比例不符、費用超限或 Gas 保留不足時，餘額會留在錢包。

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

## RPC 額度與掃描

RPC 額度：`POLL_INTERVAL_MS` 控制完整錢包／部位掃描，預設 5 分鐘；`MARKET_REFRESH_MS` 與 `MARKET_STATE_REFRESH_MS` 控制鏈上池資料重讀，預設同為 5 分鐘。APR 的 Fables HTTP 來源不計入 RPC 額度，但舊的每分鐘刷新會連帶觸發其他池與積分掃描，現在僅在符合再平衡資格且其他執行閘門通過後抓取。完整部位掃描仍對活躍 LP 讀取最新鏈上狀態，送交易前也會重新驗證。首次讀到 OOR 後滿 15 分鐘，下次 5 分鐘鏈上掃描仍 OOR 才可再平衡；實際觸發時間會受掃描相位與 RPC 可用性影響。積分的全市場 Swap 掃描保留每日精確歸屬，但為節省 RPC，單筆 Swap 在同一天內的事件時間可能是估計值；這些市場事件不會出現在錢包交易紀錄。RPC 回報 429／額度用盡時，非必要的全市場掃描及主監控會暫停重試 5 分鐘。

## 區間內閒置餘額加倉

同池再平衡的首次重新存入會把撤池所得與錢包原有的同池代幣合併預演與存入，減少緊接著的第二次加倉。USDG 交易對只在 USDG 側預留錢包零頭，換幣配比也稍微偏向留下 USDG；價格變動、滑價、整數取整與價格衝擊上限仍可能讓少量 meme 幣留在錢包。

`AUTO_TOPUP_ENABLED=true` 會把目前唯一、仍在區間內的 LP 交易對閒置代幣投入原區間，保留 `AUTO_TOPUP_DUST_BPS` 零頭與 `AUTO_TOPUP_MIN_GAS_ETH` Gas。預設不換幣；若要處理比例不符的餘額，須另外設定 `AUTO_TOPUP_SWAP_ENABLED=true`、**單一** `AUTO_TOPUP_SWAP_POOL_ID` 及該池的 `AUTO_TOPUP_MAX_SWAP_PRICE_IMPACT_BPS`。一般再平衡仍受獨立的 `MAX_SWAP_PRICE_IMPACT_BPS` 限制。

同池 OOR 再平衡會在撤出舊 LP 前，透過 `eth_simulateV1` 預演 guarded 撤池、必要的授權與換幣、重新存入 tight 區間，並檢查 Gas 預算；任何預演失敗都保留舊 LP。`npm run preflight:oor` 可唯讀檢查目前唯一的 OOR 部位。`-- --diagnostic-max-bps=350` 只調整該次診斷的報價上限，**不會**改變實盤設定。若要為單一池設定獨立實盤上限，需同時指定 `OOR_REBALANCE_SWAP_POOL_ID` 與 `OOR_REBALANCE_MAX_SWAP_PRICE_IMPACT_BPS`；其他池仍使用 `MAX_SWAP_PRICE_IMPACT_BPS`。首次觀測到 OOR 後滿 `OOR_CONFIRM_DELAY_MIN` 分鐘，下一次成功讀取鏈上 Tick 時若仍在原 LP 區間外，才具備自動撤池資格；任何一次讀到回到區間內都會清除計時。複查受監控週期與 RPC 可用性影響，可能晚於 15 分鐘。

部分 Solady ERC20 將 ERC20→Permit2 授權固定為無限額，並拒絕 `approve(Permit2, ...)`。機器人只有在現有授權確為 `uint256.max` 且唯讀呼叫回傳 `Permit2AllowanceIsFixedAtInfinity()` 時才跳過該層重設；Permit2→Router 仍必須設定定額與有效期限。

執行 `npm run preflight:topup` 可唯讀預演目前唯一 LP 的授權、換幣、存入與模擬後 Tick。機器人會在任何交易前模擬完整順序；授權完成後再用最新池價與已上鏈的授權重跑「換幣→存入」模擬。任一步失敗即不送出換幣，退回不換幣加倉或記錄失敗。鏈上狀態仍可能在模擬與成交間改變；若換幣已成交而存入失敗，journal 進入 `recovery_required` 並暫停後續自動交易。

Points 全池歷史資料在背景分段回補；回補未追上鏈頭或個人費用有缺口時，中控台保留官方已結算分數，不顯示無法驗證的即時增量，且不延遲 LP 監控。

建議先跑 24 小時以上 dry-run，確認：

- pool / range / shares 與 Fables UI 一致
- OOR 判斷一致
- fee accrual 有增量
- gas 與 lifecycle tx 能入 ledger
- PnL baseline 沒有被外部轉帳污染
- Points estimate 與 leaderboard 趨勢同方向

## 外部存提

中控台每次鏈上監控掃描時，透過 Blockscout 對帳基準建立後的 USDG／ETH 外部 EOA 轉入與轉出；USDG 按 1 美元、ETH 按轉帳分鐘的 Coinbase ETH/USD 收盤價計入本金。已辨識的 Prologue 獎勵領取列為收益。舊基準若缺 ETH，會用基準時間以前最後一筆鏈上 ETH 餘額與當時 ETH/USD 價格補齊；資料缺漏時淨損益顯示待補齊，不顯示可能誤導的數字。

若從合約錢包、交易所合約或非 USDG／ETH 資產轉入資金，需在 Dashboard 新增 cashflow adjustment，並註明來源：

- 存入：正數
- 提領：負數

不要為已自動對帳的 USDG／ETH EOA 轉帳重複新增調整，否則本金會重複計入。淨損益為目前追蹤資產價值減起始成本與外部淨轉入；目前部位的無常損失是診斷值，不再額外加減一次。

## Points 校準

分數頁會自動同步 Fables 已結算分數，以本錢包的 LP 存提、已領及可領費用對帳。優先使用個人費用占全市場 swap fee 的完整資料；分母缺漏時，若個人費用紀錄完整，改用最近兩次官方結算的分數與累計費用差建立暫估倍率，再依每日點數預算換算。若 guarded 撤池的費用尚未能從 receipt 與前次應收費用紀錄對上，不顯示待結算分數，直到缺口修復。官方資料暫時無法取得時，可手動填入備援分數；手動值不會覆蓋已同步的官方分數。

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
