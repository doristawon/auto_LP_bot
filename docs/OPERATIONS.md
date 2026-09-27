# Operations Runbook

## 初次啟動

```bash
npm install
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

### 2026-09-27 MOO/USDG 小額實盤紀錄

- 首次建倉指定池：`0x6b187fad6ca2dcb913f2451c5d5e24d3d77b9d09ce272c2c99f64dac672bc485`。`RANGE_PRESET=fables-tight` 依 Fables 前端的 Tight 規則（約 ±1%，以池子的 Tick 間距取整）計算；首次鏈上部位 Tick `320000–320400`。`TIGHT_WIDTH_BPS=120` 僅供 `custom-bps` 模式使用。截圖上的價格與 APR 是當時畫面，實際區間每次以最新鏈上 Tick 計算。
- 小額首次建倉用 `20 USDG`。預檢可用 `npm run bootstrap:moo -- --amount-usdg=20`，`--execute` 會送出真實交易；腳本發現現有 MOO/USDG LP 時會拒絕重複建倉。本次 swap TX：`0x3211b233f100e10a0b6ad7681ce848ab69ad015659b23881d3c4e82e59298a7b`；deposit TX：`0x121e252f4199824f9fab0c9013f2a0f60ed4c9b2aa381575cd10093738882e57`。
- Guard implementation：`0xEA894F3427949be7B2b89e20EF9fCdabb6bA2517`；wallet EIP-7702 delegation、`guardVersion`、`IMPLEMENTATION` 及真實區間內部位觸發的 `InRange` revert 均已核對。守護合約不會讓區間內 LP 被提領。
- 錢包最早可見入金在區塊 `73275234`，掃描起點設為 `73275000`；RPC 限制單次 `eth_getLogs` 5,000 blocks，分段上限設為 5,000、最小 500。LP range candidates 已保存到錢包專屬 state，重啟後仍能接管。
- 中控台網址 `http://127.0.0.1:18087`。綁定本機回環位址時不要求中控台權杖；若改綁外部網路介面，必須設定 `DASHBOARD_TOKEN`。排程工作 `AutoLPBotDashboard` 維持網站與監控程序；程序重啟會安全暫停新的再平衡，需要在中控台重新按「啟動」。
- 首次區間外的真實 withdraw → swap → deposit 尚未發生；發生時必須核對三筆 receipt、舊 shares 歸零、新 shares 與本機帳務。若顯示 `recovery_required`，停止新的資產移動並按下文流程檢查。

預設網址為 `http://127.0.0.1:8787`；若本機埠被佔用，請使用 `.env` 中 `DASHBOARD_PORT` 指定的網址。本工作目錄目前使用 `http://127.0.0.1:18087`。

中控台介面使用繁體中文，功能分頁如下：

- **總覽**：資產價值、損益、LP 部位、執行狀態與安全閘門。
- **錢包與 RPC**：匯入助記詞／私鑰／唯讀地址，切換錢包並輸入 Robinhood RPC。
- **池子監控與 APR**：列出 Fables 池、TVL、24 小時成交量／手續費、池級 APR 與監控清單。
- **LP 部位與區間檢查**：查看部位、區間外狀態與再平衡資格。
- **分數即時模擬**：獨立顯示分數基準、估算增量、每日拆分及最近模擬時間。
- **帳務與事件紀錄**：手動現金流調整及交易／帳務事件。

APR 更新、區間檢查與分數模擬可分別在各自分頁設定，設定保存在本機 `data/dashboard-settings.json`，適用於所有錢包。預設 APR 更新為 60 秒、區間檢查為 300 秒、分數模擬為 15 秒；各自允許範圍會顯示在欄位旁。

池子分頁的「OOR 後再投入模式」可選擇自動挑選最高有效 APR 池，或用關鍵字搜尋後從 APR 排序下拉選單指定池。自動模式只接受新鮮 APR、未暫停、TVL 至少 `APR_POOL_MIN_TVL_USD`（預設 30,000 美元），且每項非零 Fables 登錄代幣餘額都能預先報價的候選池。跨池再投入會先檢查來源部位仍在區間外、所有兌換路徑可用並完成報價；任一條件不成立就保留原 LP，不先提領。符合 OOR 政策撤池後，將已登錄 Fables 代幣餘額兌換並以 Fables Tight 區間投入，保留無法投入的零頭及原生 ETH Gas 餘額。

設定 `PERSIST_RUNTIME_CREDENTIALS=true` 後，成功驗證的自訂 RPC 與目前錢包私鑰／地址會原子寫入本機 `.env`，並將檔案 ACL 限定為目前使用者、SYSTEM 與系統管理員；`.env` 必須維持 Git 忽略。助記詞不會保存，僅在匯入時推導並保存私鑰。API 與日誌不回傳憑證。匯入／切換錢包會強制預演、關閉鏈上寫入與自動重新部署，並暫停執行；每次程序重啟也都會保持暫停，需確認啟動條件後按下大按鈕。每個錢包使用獨立狀態與帳務紀錄。

自訂 RPC 會先驗證實際 `eth_chainId` 為 4663，並保留官方公開 RPC 作讀取備援。池級 APR 沿用 Fables 公開估算公式：過去 24 小時手續費 × 365 ÷ 目前 TVL；它不是此錢包的實際報酬。Fables 統計來源暫時無法使用時，鏈上監控仍會繼續，缺少資料的 APR 會留白。

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
