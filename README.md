# Auto LP Bot — Fables.fi / Robinhood Chain

> 目前工作目錄包含 Fables 池級 APR 與 RPC 控制，也支援 OOR 後投入最高有效 APR 池或指定池；本機預設每 5 分鐘評估區間，淺度 OOR 最長等待 30 分鐘。

錢包助記詞／私鑰僅傳送至本機回環中控台；助記詞不會保存。設定 `PERSIST_RUNTIME_CREDENTIALS=true` 後，通過驗證的目前錢包私鑰／地址及 Robinhood RPC 會原子更新到 Git 忽略的本機 `.env`，並限制檔案 ACL；API 與日誌不回傳憑證。匯入或切換錢包會強制 `DRY_RUN=true`、關閉鏈上寫入與自動重新部署，並暫停執行；每次程序啟動仍保持暫停，需在條件通過後按下啟動。自訂 RPC 套用前會實際查詢 `eth_chainId`，並保留官方 RPC 作為讀取備援。

池級 APR 取自 Fables 公開市場統計，沿用頁面公式「24 小時手續費 × 365 ÷ 目前 TVL」；這是近期年化估算，不代表個人實際收益或收益保證。APR、TVL 與成交量／手續費統計使用 Fables 公開來源；資料暫時無法取得時 APR 會留白，依 APR 跨池選擇再投入目標會停止。鏈上池子、range、餘額與交易狀態則由 Robinhood Chain RPC 讀取。

OOR 再投入可設定為最高有效 APR 或指定池。最高 APR 候選需有新鮮統計、未暫停，且 TVL 達 `APR_POOL_MIN_TVL_USD`。ERC20 跨池候選必須在提領前完成「guarded 撤池→路由換幣→比例換幣→Tight 存入」連續 RPC 模擬，並通過整次換幣成本、Gas、餘額與授權檢查；未通過時保留原池重建。原生 ETH 池目前不具備可驗證的存入與路由交易流程，自動跨池會跳過，池清單會標示此限制。手動按「更新池子換幣報價」後，清單顯示每池約 10 美元試算的方向、時間與成本；「約 3%」標記僅代表該筆樣本落在 2.5% 至 3.5%，不代表實際換倉成本固定。預演資金範圍只涵蓋來源與目的池交易對的錢包餘額及來源提領預估，不掃入無關代幣。現有 LP 在區間內時，可將同交易對的閒置餘額加倉。預設只使用現有代幣比例；若明確設定 `AUTO_TOPUP_SWAP_ENABLED=true`、單一 `AUTO_TOPUP_SWAP_POOL_ID` 與獨立的 `AUTO_TOPUP_MAX_SWAP_PRICE_IMPACT_BPS`，才會在「授權→兌幣→存入」整串 RPC 模擬成功後兌幣加倉。兌幣前會再次確認價格衝擊、錢包餘額、原區間及完整模擬，並保留設定的零頭與 Gas。指定池可用關鍵字篩選 APR 排序下拉選單。預設區間檢查週期為 5 分鐘，深度 OOR 仍需連續 2 次確認；淺度 OOR 最長等待 30 分鐘。

同池 OOR 實盤現在也要求撤池前完成「guarded 撤池→必要換幣→tight 入池」連續 RPC 模擬及 Gas 預算檢查；任一步失敗就保留舊 LP。`npm run preflight:oor` 可唯讀檢查目前部位，參數 `-- --diagnostic-max-bps=350` 僅供診斷，不修改實盤上限。單一池的實盤上限可用 `OOR_REBALANCE_SWAP_POOL_ID` 與 `OOR_REBALANCE_MAX_SWAP_PRICE_IMPACT_BPS` 明確設定，其餘池沿用一般上限。Solady 固定無限額 Permit2 授權的代幣，僅在合約回傳特定固定授權錯誤時略過無法執行的 ERC20 重設，Router 仍使用定額、限時的 Permit2 授權。

## v0.6.0 — 本機錢包、池級 APR 與 RPC 控制

- Fables 官方活躍池清單會顯示目前 Tick、TVL、24 小時成交量與手續費，以及池級 APR。
- 可在中控台將活躍池加入或移出本機監控清單；清單依錢包分開保存。
- 可在程序記憶體掛載多個錢包並切換目前監控錢包；每個地址使用獨立狀態與帳務紀錄。目前選取的簽署錢包可保存到受保護的本機 `.env`。
- 可輸入自訂 Robinhood RPC；系統會先驗證鏈 ID 為 4663，並保留官方端點作為讀取備援。啟用持久化後，驗證通過的 RPC 會保存到本機 `.env`，不會由 API 回傳。
- 錢包秘密資料只供目前程序的簽署器使用，不會寫入帳務、狀態、API 回應或紀錄檔。

> Review correction: **dry-run 不得改變策略 state**。v0.3.4 起，`rebalance.dry_run` 只寫 ledger，不再重設 OOR timer、cooldown 或 rebalanceHistory；只有 executor 回報完整 `completed` 才能 commit strategy state。另將 pre-withdraw inventory / deposit plan 明確標為 provisional，live 執行前必須在 withdraw/swap receipt 後重算。

## v0.5.0 — Deployment control center + manual canary control

中控台新增：

- signer / live writes / auto redeploy / EIP-7702 guard config + runtime readiness
- recovery journal、topology cooldown、current block / RPC health
- OOR excursion、elapsed time、deep confirmation、eligibility、target range
- range policy / slippage / max gas 顯示
- `Scan now · no trades`：fresh scan 但強制 `executeRebalances=false`
- 指定 position 的 Manual Rebalance
- `DASHBOARD_MANUAL_CONTROL_ENABLED=false` 預設 SAFE-OFF；只有顯式 armed 才接受 capital-moving dashboard request

Manual Rebalance 不提供 bypass：In-Range Hold、OOR hysteresis、topology revalidation/cooldown、Pause、rate limit、live signer/guard gates、receipt state machine 全部照常生效。

## v0.4.1 — Replay and executor hardening

此版本加強 receipt reconciliation、recovery pause、guard identity 驗證與依 pool/range 分離的狀態管理。公開文件與 CI 不保存特定錢包的地址、部位快照、績效數字或交易時間線；回歸檢查以通用測試與脫敏資料為主。

Executor 安全性改進：

- 所有 ERC20→Permit2、Permit2→Universal Router、token→Fables hook approvals 優先在 withdraw 前完成；approval 失敗時 LP principal 尚未移動。
- EIP-7702 delegation 除了 pointer，還驗證 `guardVersion == keccak256("Fables7702Guard/v1")` 與 `IMPLEMENTATION == EIP7702_GUARD_ADDRESS`。
- exact-input swap receipt 強制 `actual spent == requested amountIn`；under-spend / over-spend 都 fail closed。
- deposit 前再次讀 current tick，以最新狀態重算 centered range / BigInt liquidity / amount caps。
- deposit receipt 後再讀 `rangeKey(newRangeId)`，完整驗證 PoolKey + tickLower/tickUpper。
- withdraw 後任何 failure 進 `recovery_required` 時，BOT 自動 Pause；新 write 必須先完成 recovery review。
- `solc` 移到 devDependencies；CI 對 production dependency tree 執行 high-level npm audit。
## v0.4.0 — Full receipt-reconciled executor + exact BigInt math + atomic OOR guard

三個原本的 full-live blockers 已全部實作：

1. **Fables withdraw ABI 已反解並驗證**
   - 真實 selector：`0x289a2a15`
   - verified signature：
     `withdrawAndClaim((address,address,uint24,int24,address),int24,int24,uint128,address,uint128,uint128,uint256,uint16)`
   - `withdrawAndClaim` selector 與參數布局已有 ABI 回歸覆蓋。
   - regression tests 會驗證支援的 selector、參數與 calldata 編碼。

2. **Receipt-reconciled withdraw → swap → deposit state machine**
   - withdraw 前只使用 exact BigInt principal math 產生 min-out。
   - withdraw receipt 後讀 **actual raw wallet delta**，才重新計算 swap direction / amount。
   - Direct V4 route 重新 quote + allowance check + `eth_call` simulation。
   - swap receipt 後再次讀 actual balances / current tick。
   - deposit liquidity / caps 只使用 post-swap raw strategy inventory。
   - deposit receipt 後驗證 `Deposited` event、新 ERC-6909 shares > 0、舊 shares 已清空。
   - 只有完整走到 `completed` 才 commit strategy cooldown/history。
   - withdraw 後任何 failure 會進 `rebalance.recovery_required`，保存 tx hashes/raw balances，並全域鎖住新的自動 rebalance；可用 `npm run inspect:recovery` 查明狀態。

3. **BigInt fixed-point + Atomic In-Range Hold**
   - `src/math/v4-fixed.js` port Uniswap TickMath / LiquidityAmounts 核心公式；live math 不使用 JS `Number`。
   - atomic guard：`contracts/Fables7702Guard.sol`。
   - guard 透過 EIP-7702 在 EOA address context 執行，Fables hook 看到的 `msg.sender` 仍是原 wallet，因此能操作原本 ERC-6909 LP ownership。
   - 同一筆 withdraw transaction 先讀官方 StateView current tick；只要 `tick >= tickLower && tick < tickUpper`，整筆 revert。
   - Robinhood Chain mainnet 已在 block `71628862` 實際觀察到 type-4/EIP-7702 transaction，chain capability 已確認。

### 一次性 atomic guard 啟用流程

安全預設仍是：
```env
DRY_RUN=true
ENABLE_LIVE_WRITES=false
ENABLE_AUTO_REDEPLOY=false
EIP7702_GUARD_VERIFIED=false
EIP7702_GUARD_VERIFIED_FOR=
```

先在獨立 canary wallet 驗證，再碰主錢包。部署合約需設定專用 `GUARD_DEPLOYER_PRIVATE_KEY`，且不可與 LP signer 的 `PRIVATE_KEY` 相同：

```bash
npm ci
npm run compile:guard

# 明確允許部署
DEPLOY_EIP7702_GUARD=true \
GUARD_RPC_URL=https://rpc.mainnet.chain.robinhood.com \
GUARD_DEPLOYER_PRIVATE_KEY=... \
npm run deploy:guard
```

把輸出的 implementation address 放入：
```env
EIP7702_GUARD_ADDRESS=0x...
```

再做 wallet delegation：
```bash
npm run setup:guard
```

這是一筆 EIP-7702 type-4 transaction。委派後必須先跑：

```bash
npm run verify:guard
```

`verify:guard` 會使用目前 In-Range LP 做 **eth_call-only** canary；預期結果一定是 `in-range-withdrawal-blocked`。只有 delegation、guardVersion、In-Range block canary 全部通過後，才可人工設定；`EIP7702_GUARD_VERIFIED_FOR` 必須與目前 `WALLET_ADDRESS` 完全一致，換 signer 後需重新 canary：

```env
EIP7702_GUARD_VERIFIED=true
EIP7702_GUARD_VERIFIED_FOR=<same as WALLET_ADDRESS>
DRY_RUN=false
ENABLE_LIVE_WRITES=true
ENABLE_AUTO_REDEPLOY=true
```

撤銷 delegation：
```bash
npm run setup:guard -- --revoke
```

> Guard 尚未部署/委派/驗證時，live auto-redeploy 會 fail closed；程式不會因為只有 private key 就自行改變 EOA code。

### Swap route 範圍

Production executor 已能完整執行並驗證 **direct Fables V4 pool route**。這條路徑已用 Robinhood Chain Quoter / Universal Router 2.1.2 做雙向 simulation。它是 deterministic、安全 fallback，**不是保證全球最佳路徑**；未來可再加入 V3↔V4 route competition，但不影響目前 receipt-reconciled state machine 的正確性。

### Swap path review

- Bot 的 minimal direct V4 path 使用 Universal Router `V4_SWAP (0x10)` + `SWAP_EXACT_IN_SINGLE (0x06) / SETTLE_ALL (0x0c) / TAKE_ALL (0x0f)`，並以 Quoter / `eth_call` 在執行前檢查可用性。
- 需要使用 LP principal 的反向兌換必須在 withdraw receipt 後，以實際 wallet delta 作為 `amountIn`；不得用 withdraw 前估算的 free balance 代替。
- 外部前端可組合 Permit2 與多段路由；direct Fables-pool route 是有效 fallback，**不是已證明的最佳 route**。正式 live 應比較可執行 routes 的實際 quote / gas / slippage。
- Swap sizing 使用該 LP 自己的 `sqrtPriceX96` relative price，不再使用可能被其他 pool 污染的 global USD graph。
- v0.4 production executor 已接入 Universal Router direct V4 route，且只在 withdraw receipt 後用 actual raw balance 重新 quote / simulate / broadcast。

### v0.3.x historical full-live blockers（v0.4 已完成）

以下為 v0.3.x review 當時的 blocker；v0.4 已逐項實作並納入 CI / regression：

1. withdraw 必須有非零 principal min-out，不能使用 `amount0Min=0 / amount1Min=0`。
2. withdraw receipt 後以**實際 wallet delta**重算 swap amount；禁止沿用 withdraw 前估算值。
3. 每個新 meme token 必須檢查/建立 ERC20→Permit2 與 Permit2→UniversalRouter allowance。
4. swap 必須在 withdraw 後重新 quote + `eth_call` simulation，receipt 後再次讀實際 balance/tick。
5. deposit range/liquidity/amount caps 必須在 post-swap tick 上重算。
6. 現有 deposit planner 使用 JS `Number` 浮點近似；live calldata 前必須改成 **BigInt / fixed-point** 的 TickMath/LiquidityAmounts。
7. deposit 前檢查 token→Fables hook allowance，並 `eth_call` 模擬；成功 receipt 後驗證新 ERC-6909 shares。
8. 要真正滿足「In Range 絕不撤 LP」，最終 live executor 應由 atomic on-chain guard 在同一交易內檢查 OOR，消除 RPC 檢查到上鏈之間的 race。

## v0.3.4 — Executor fail-closed review

Code review 發現舊 executor 在 `ENABLE_AUTO_REDEPLOY=true` 時會先 withdraw，之後才停在 redeploy gate。這會留下「LP 已拆、swap/deposit 尚未完成」的 partial execution 風險。

- v0.3.4 起：只要完整 `withdraw -> receipt reconciliation -> swap -> receipt reconciliation -> deposit -> minted-share verification` state machine 尚未完成，**所有 live rebalance writes 一律 fail closed**。
- `DRY_RUN` 仍可產生完整 rebalance/quote/deposit plan，不受影響。
- V4 swap simulation workflow 改成雙向覆蓋：USDG↔MOO、USDG↔ZZZ，避免只驗證 USDG 買 meme、卻沒驗證 meme 賣回 USDG。

## v0.3.3 — 絕對 In-Range Hold

**不可覆寫的核心規則：只要 LP 仍在原 range 內，BOT 絕不自動撤出 LP。** 自動 withdraw → swap → 窄區間 redeposit 只有在真實鏈上 tick 已 Out of Range 時才有資格啟動。

- LP membership 採 concentrated-liquidity 語義：`tick >= tickLower && tick < tickUpper` 為 In Range。
- `EDGE_BUFFER_TICKS` 只允許作 near-edge 監控提示，永遠不能授權撤 LP。
- 策略層：In Range 強制 `shouldRebalance=false`，並清除 OOR timer / deep confirmations。
- 排程層：pending rebalance 必須同時滿足 `outside===true && shouldRebalance===true`。
- BOT 執行前：重新從鏈上讀最新 tick；若已回到舊 range，記錄 `rebalance.blocked: absolute in-range hold` 並取消整輪。
- Executor 邊界再次讀取最新 PoolManager tick 並 fail closed；live withdraw 使用 atomic guard；withdraw、swap 與 deposit 仍各自受設定及 recovery gate 保護，不能用單步 write 繞過流程。
- RPC 檢查後到交易被打包前鏈上價格仍可能變動；withdraw 的 atomic on-chain OOR guard 會在交易執行時再次檢查。Live auto-redeploy 仍由 guard 身分驗證與操作設定 gate 控制。

## v0.3.2 — Range policy calibration

舊版使用 15 分鐘採樣與 90 分鐘淺度等待；目前預設改為 **5 分鐘 / 0.5% / 30 分鐘 / deep-confirm=2**。回歸測試涵蓋連續深度確認、淺度等待及回到區間時清除計時狀態。歷史錢包部位與績效資料不納入公開文件或 CI 輸出。
## v0.3.0 — 動態 wallet topology

- 預設 `TARGET_MODE=wallet-active`：不再需要每次換 meme LP 都手動改 `TARGET_POOL_IDS`。
- 從錢包的 Fables `Deposited/Withdrawn` 事件建立 range candidates，再用 `rangeKey()` 完整 PoolKey 回配 registry pool。
- 只把 `ERC-6909 balanceOf(wallet, rangeId) > 0` 的 pool 放進 execution target；已退出的 pair 自動退役。
- execution pool 與 accounting pool 分離：舊 pair 的 wallet dust / 歷史資產仍保留在 PnL 帳本。
- 同一 pool 手動換 range、或跨 pool 換 meme 標的，都視為 topology handoff；預設 120 秒只監控、不自動交易。
- position / IL / fee state 全部改成 `poolId + rangeId` scope，避免多 pair 共用 hook 時互相污染。
- Fables shared hook fee event 若無法唯一還原 PoolKey，禁止猜測 pair 歸屬與重複計算；個人 fee 仍以 `userPosition.owed` / claim receipt 為準。
- 動態 wallet-active topology 會依鏈上 deposit/withdraw 事件與仍持有的 range shares 更新目標；測試覆蓋已退出部位的退役流程。
- Fables deposit selector 對應下列函式 ABI，並由回歸測試檢查：
  `deposit((address,address,uint24,int24,address),int24,int24,uint128,uint128,uint128,uint256)`
- deposit 編碼與 liquidity / amount caps 已納入回歸測試和 dry-run plan。
- Live rebalance fail-closed：完整 redeploy 未解鎖前，禁止先 withdraw 再停在半套狀態。

> 歷史註記：此段描述的是 v0.3.0 當時狀態；withdraw ABI / receipt state machine / exact fixed-point math 已於 v0.4.0 完成。

## v0.2.1 新增

- Tight 新 range 的資產比例計算：自動判斷 0→1 或 1→0 需要交換多少。
- 直接呼叫 Robinhood Chain Uniswap v4 Quoter，對 Fables 的實際 PoolKey/hook 做 `eth_call` quote。
- `SWAP_SLIPPAGE_BPS` 產生 minOut，Dashboard 顯示下一筆預估 swap。
- 每 5 分鐘預設寫入一筆 `portfolio.snapshot`，保留 PnL / HODL / IL / fees / gas / Points 時序。
- Reference tx inspector 可選配 Blockscout API：抓 transaction / logs / internal tx / raw trace / verified ABI，自動定位 Fables `Deposited` hook call 與 candidate selector。
- 鏈上池狀態與 quote 透過 Robinhood Chain RPC 讀取；市場 APR/TVL/成交量與官方 Points 使用 Fables 公開資料來源。Blockscout 是 reference transaction 反解的可選來源。

> 安全狀態：withdraw → swap → deposit 執行程式碼已實作；live 預設仍關閉，只有當前 signer 的 guard canary、設定與 recovery gate 全部通過才可進入 live。

## v0.2 重點

鏈上 pool、range、fee 與交易結果由 Robinhood Chain 讀取；Fables 公開市場統計及官方 Points 另使用公開資料來源。專案不依賴私有交易 API、API key 或網頁 DOM：

```text
Robinhood RPC / managed RPC
        │
        ├── FablesPoolRegistry.activePools()
        ├── PoolManager state (tick / sqrtPrice / liquidity)
        ├── Fables hook ERC-6909 range ledger
        ├── Deposited / Withdrawn / FeesCollected logs
        ├── wallet token balances
        └── eth_sendRawTransaction / receipts
                 │
                 ▼
           Auto LP Bot v0.2
        ┌────────┼──────────┐
        │        │          │
     strategy  accounting  guarded executor
        │        │          │
        ▼        ▼          ▼
     rebalance   JSONL     claim / withdraw
       plan      ledger      (verified only)
        │        │
        └────┬───┘
             ▼
      Local Dashboard :8787
```

不需要 Fables 私有 API、API key，也不需要讓 BOT 依賴 Fables 網頁 DOM。

## 已完成

### 鏈上監控

- Robinhood Chain mainnet chain ID `4663`
- 多 RPC endpoint + ethers `FallbackProvider`
- FablesPoolRegistry 自動發現 active pools
- 讀取每個 Fables hook 的 PoolManager
- 直接讀 `sqrtPriceX96 / tick / liquidity`
- Fables ERC-6909 `balanceOf / rangeKey / userPosition`
- `Deposited / Withdrawn / FeesCollected` event indexer
- adaptive `eth_getLogs` chunking + reorg lookback
- public RPC 可用於開發，正式部署可改 managed/archive RPC

### 自動 LP 策略

- 預設 Tight 約 `±1.2%`
- 自動 tickSpacing 對齊
- 連續 Out-of-Range confirmation
- position cooldown
- 每小時 rebalance rate limit
- 本地 Pause / Resume kill switch
- dry-run 預設啟用

### 本地中控台

預設：`http://127.0.0.1:8787`

Dashboard 顯示：

- 目前 LP + 錢包相關資產總值、Net PnL、HODL baseline、vs HODL、IL
- LP fee、未領 fees、Gas fee、Fables Points
- 各 LP current tick / range / OOR excursion / OOR elapsed / deep confirmations / eligibility / target range
- signer、Live Writes、Auto Redeploy、Manual Control arming
- EIP-7702 guard config flag + runtime identity readiness
- recovery state / active execution journal / topology cooldown
- RPC health / current block
- 5m / 0.5% / 30m / deep-confirm=2 policy 與 withdraw/swap/deposit slippage、max gas
- append-only transaction / accounting ledger

Dashboard 控制：

- `Scan now · no trades`：立即讀鏈上與 accounting，但不執行 rebalance。
- `Pause new execution / Resume`：阻止新的 rebalance；不會硬中斷已開始的 capital-moving state machine。
- `Manual Rebalance`：只對已符合 OOR policy 的 position 開放；預設由 `DASHBOARD_MANUAL_CONTROL_ENABLED=false` 關閉。
- 手動 cashflow adjustment / Points baseline 只影響 accounting。

### 交易紀錄與會計

`DATA_DIR=./data` 下會建立：

```text
data/
├── events.jsonl              # append-only 事件/交易/會計 ledger
├── latest-snapshot.json      # Dashboard 最新狀態
├── portfolio-baseline.json   # HODL / PnL 起始基準
└── reference-tx/             # reference tx inspect artifacts
```

重要事件類型：

- `lp.deposit`
- `lp.withdraw`
- `pool.fee`
- `fee.accrual`
- `fee.realized`
- `tx.sent`
- `tx.confirmed`
- `rebalance.dry_run`
- `rebalance.failed`
- `rebalance.redeploy_gated`
- `cashflow.adjustment`
- `points.actual_baseline`
- `execution.control`

## PnL 與 IL 定義

### Portfolio Net PnL

```text
Tracked Assets
= LP principal
+ unclaimed LP fees
+ target-token wallet balances

Gross PnL
= Current Tracked Assets
- Initial Portfolio Baseline
- Net External Cashflow

Net PnL
= Gross PnL（追蹤原生 ETH 時 Gas 已反映在 ETH 餘額）
```

追蹤資產包含 LP、本錢包相關代幣及原生 ETH。USDG／ETH 的外部 EOA 轉入與轉出由 Blockscout 對帳，ETH 轉帳成本採交易分鐘的 ETH/USD 價格；Prologue 領取另列為獎勵。淨損益拆為持幣價格損益、已追蹤 LP 手續費、已領獎勵與剩餘 LP／兌換／Gas 損益，後者也包含估值誤差。當外部轉帳掃描或舊 ETH 基準無法補齊時，中控台暫不顯示淨損益；合約來源或其他資產轉入需手動帳務調整。

### Impermanent Loss（無常損失）

每個 position 首次被 BOT 追蹤時記下當時兩種 token 數量：

```text
HODL Value(t)
= initial token0 amount × price0(t)
+ initial token1 amount × price1(t)

IL(t)
= current LP principal value - HODL Value(t)
```

因此：

- `IL < 0`：相對單純 HODL 有損失
- `IL > 0`：相對 HODL position principal 較高
- fees 另外列，不混入 LP principal IL

Portfolio 層另外保留整體 HODL baseline，方便判斷「做 LP」相對「什麼都不做」是否真的有超額收益。

## LP fees

BOT 會持續讀 `userPosition().owed0 / owed1`，將同一 range 的 owed-fee 增量記為 `fee.accrual`。v0.5.1 不再因同一 range shares 改變就丟棄 owed-fee 增量；第一次看到一個 range 時仍只建立 baseline，不把啟動前既有 owed fees 冒充成 BOT 期間新增收益。

`FeesCollected` 仍保留作診斷資料，但 **Points V2 不再拿 shared-hook `FeesCollected` 當全市場 denominator**，因為該事件不能安全歸屬到唯一 PoolKey，會造成重複或漏算。

## Fables Points Accounting V2

Points V2 依目前已驗證的活動規則使用：

```
dailyBudget = 1,000,000,000 × weeklyWeight / 7
dailyPoints = dailyBudget × userEffectiveFeeUsd / globalEffectiveFeeUsd
```

關鍵差異：

1. **Campaign day 固定以 02:00 UTC 為邊界**，不是 00:00 UTC。官方 points baseline 若沒有指定時間，Dashboard 會自動正規化到最近一個 02:00 UTC distribution boundary。
2. **Global denominator 改讀 Uniswap v4 PoolManager `Swap(poolId,...,fee)`**。每筆 swap 都有明確 `poolId`，因此不受 shared Fables hook 影響。
3. USDG 作為 input 時直接由 USDG input fee 計價；非 USDG token 作 input、USDG 作 output 時，用同一筆 swap 的 realized USDG output 對 fee 估值，不使用之後的現價。
4. 非 USDG pair 或任何無法可靠估值的 swap 會標成 `unpriced`；只要 denominator coverage 不完整，`estimatedTotal` 直接回 `null`，Dashboard 只顯示 `~provisionalEstimatedTotal`，避免假精準。
5. `userTrackingStartedAt` 會記錄 Points V2 user-fee numerator 的可靠追蹤起點。完整 `withdrawAndClaim` 會用 **receipt token delta - BigInt exact LP principal - 最後一次已觀察 owed fee** 補入最後一小段尚未被 polling 捕捉的 fee；若遇到無法安全重建的 standalone claim / owed reset，V2 會標記 `incomplete-user-coverage`，不冒充 exact prediction。
6. 每次輸入新的官方 Points 總分時，V2 會把舊 baseline 到新 distribution boundary 的 `predictedDelta` 與官方 `actualDelta` 寫成 `points.reconciliation`，保留誤差 points / % 供後續校正。新的官方 checkpoint 也會重新建立其後區間的可信 coverage。

Snapshot 主要欄位：

- `actualBaseline / actualBaselineAt`：最後一次官方 Points checkpoint。
- `settledEstimatedDelta`：已完成 campaign day、且 coverage 完整的預估。
- `projectedCurrentDay`：目前尚未結算這一天，依當下 fee share 投射整天 allocation。
- `estimatedTotal`：只有 numerator/denominator coverage 完整才提供。
- `provisionalEstimatedTotal`：coverage 不完整時仍保留供診斷，但 Dashboard 會用 `~` 標示。
- `denominatorCoveragePct`：可可靠 USD 計價的 global swaps 比例。
- `lastReconciliation`：最近一次官方 Points 與預測誤差。

舊版 state 若把 `ACTUAL_POINTS_BASELINE_AT` 記在手動輸入時間，啟動時會自動遷移到對應的 02:00 UTC campaign boundary。

中控台也會讀取 Fables 官方 Points API 的錢包結算分數，並比對 Fables 索引器的 LP 存提／領費紀錄與鏈上可領費用。官方分數作為基準；Points V2 優先用完整的鏈上個人 fee 與全市場 swap fee 計算待結算估值。若全市場分母不完整但本錢包費用覆蓋完整，改用最近兩次官方結算的分數差／費用差，按當日點數預算調整後顯示「官方費用校正暫估」；個人費用有未解決缺口時僅顯示官方已結算分數，不顯示即時增量。EIP‑7702 guarded 撤池的費用可從錢包 receipt 對帳；歷史缺口只在找到匹配的應收費用下降紀錄，或同一部位、撤池前五分鐘內且仍持有份額的應收費用快照時補記。官方累計費用若高於錢包費用彙總，中控台會標示兩種來源不能直接相減推算待結算費用。

## 快速開始

Node.js 20+：

```bash
npm ci
cp .env.example .env
npm run once
npm start
```

打開：

```text
http://127.0.0.1:8787
```

### 建議 production RPC

`.env`：

```env
RPC_URLS=https://YOUR-MANAGED-RPC,https://rpc.mainnet.chain.robinhood.com
```

第一個 endpoint 同時作 write provider；其餘作 read failover。

Robinhood public RPC 適合開發/備援。常駐 BOT 建議至少放一個 managed provider；歷史 backfill 則使用 archive RPC。

## Reference deposit transaction inspector

Fables 新建 range 的 deposit ABI 已有回歸覆蓋；inspector 可用於檢查 Fables 是否更換 selector / calldata：

```bash
npm run inspect:tx
# 或
node src/tools/inspect-reference-tx.js 0x...
```

會輸出：

```text
data/reference-tx/<hash>.json
```

包含：

- from / to
- selector
- raw calldata
- receipt logs
- gas
- 若 RPC 支援 `debug_traceTransaction`：完整 call trace
- 如果 top-level calldata 是已知 Fables hook ABI：直接 decode

本機可用環境變數或私密設定提供 reference transaction hash；CI 不將其寫入 workflow log/artifact。
只有完成 target contract、selector、call trace、allowance、swap/deposit params、minted ERC-6909 shares 的驗證後，才解除 `ENABLE_AUTO_REDEPLOY` safety gate。

## Live mode 現況

**完整 executor code path 已實作；live auto-redeploy 預設仍 fail-closed。**

已完成的 live path：

1. Atomic EIP-7702 OOR guard。
2. verified `withdrawAndClaim` + BigInt withdraw min-out。
3. receipt 後 actual wallet delta reconciliation。
4. actual inventory 的 direct V4 quote / Permit2 allowance / `eth_call` simulation / exact-input swap。
5. swap receipt exact-spend + minOut assertion。
6. post-swap 最新 tick / BigInt liquidity / amount caps 重算。
7. Fables deposit preflight + receipt + PoolKey/range + ERC-6909 shares 驗證。
8. partial execution journal + `recovery_required` + automatic execution Pause。

安全預設仍為：

```env
DRY_RUN=true
ENABLE_LIVE_WRITES=false
ENABLE_AUTO_REDEPLOY=false
EIP7702_GUARD_VERIFIED=false
EIP7702_GUARD_VERIFIED_FOR=
```

最後的**操作性啟用條件**不是缺 code，而是必須在持有 private key 的本地安全環境完成：

```bash
npm run compile:guard
npm run deploy:guard
npm run setup:guard
npm run verify:guard
```

`verify:guard` 必須以目前 In-Range LP 證明 atomic withdraw canary 被 block，之後才設定 `EIP7702_GUARD_VERIFIED=true` 與相同 signer 的 `EIP7702_GUARD_VERIFIED_FOR`，再考慮小額 canary。GitHub/repo 不持有 private key，因此不會自動替主錢包做 delegation 或 live broadcast。

## Dashboard API

預設只綁 localhost：

- `GET /api/state`
- `GET /api/events?limit=200`
- `GET /api/control/status`
- `POST /api/control/pause`
- `POST /api/control/resume`
- `POST /api/control/scan` — refreshes local state without sending trades
- `POST /api/control/rebalance` — requires `DASHBOARD_MANUAL_CONTROL_ENABLED=true` and JSON `confirm: "REBALANCE"`
- `POST /api/points/baseline`
- `POST /api/cashflow`

Dashboard 綁定 loopback（例如 `127.0.0.1`）時不要求 `DASHBOARD_TOKEN`，符合本機部署需求；若要綁定外部網路介面，必須設定權杖。

## 測試

```bash
npm run check
npm test
```

以 `npm test` 執行 Node.js built-in test suite。

## Production activation checklist

1. 在獨立 canary wallet 部署 `Fables7702Guard`。
2. 執行 EIP-7702 delegation，確認 wallet code 為 `0xef0100 + guardAddress`。
3. `npm run verify:guard` 通過 exact version / implementation / In-Range block canary。
4. 使用小額 LP 做一次 OOR canary，完整驗證 withdraw → swap → deposit receipt state machine。
5. 驗證 dashboard / ledger 的 gas、fee、PnL、execution journal 與 explorer receipt 一致。
6. 確認 recovery 流程後，再逐步提高可管理資金；不直接以完整本金首次開 live。
7. Direct Fables V4 route 保留為 deterministic fallback；之後可再增加 V3↔V4 route competition 以優化 netOut，但不影響 safety correctness。

## 資安

- 不要提交 `.env` / private key。
- BOT 使用獨立 hot wallet。
- Dashboard 預設只開 loopback。
- live executor 只允許已驗證 contract / calldata 路徑。
- 所有 unknown selector 都 fail closed。
