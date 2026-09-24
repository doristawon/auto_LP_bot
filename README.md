# Auto LP Bot — Fables.fi / Robinhood Chain

> v0.3.4：API-less on-chain LP monitor + dynamic wallet-active topology + local control center + PnL / gas / fee / Impermanent Loss / Fables Points ledger + guarded rebalance executor.

> Review correction: **dry-run 不得改變策略 state**。v0.3.4 起，`rebalance.dry_run` 只寫 ledger，不再重設 OOR timer、cooldown 或 rebalanceHistory；只有 executor 回報完整 `completed` 才能 commit strategy state。另將 pre-withdraw inventory / deposit plan 明確標為 provisional，live 執行前必須在 withdraw/swap receipt 後重算。

### Swap path review

- Bot 的 minimal direct V4 path 使用 Universal Router `V4_SWAP (0x10)` + `SWAP_EXACT_IN_SINGLE (0x06) / SETTLE_ALL (0x0c) / TAKE_ALL (0x0f)`；USDG→MOO、USDG→ZZZ 已用真實 wallet allowance 做 `eth_call` 成功。
- 反向 MOO/ZZZ→USDG 在 withdraw **之前**模擬會回 `TRANSFER_FROM_FAILED`，因 meme token principal 仍鎖在 LP；最終 swap simulation 必須放在 withdraw receipt 後，以實際 wallet delta 作 amountIn。
- 真實手動 ZZZ→USDG 成功 TX 顯示前端可能使用 Permit2 + 多段 V4 + V3/WETH 的複合路徑；因此 direct Fables-pool route 是有效 fallback，**不是已證明的最佳 route**。正式 live 應比較可執行 routes 的實際 quote / gas / slippage。
- Swap sizing 使用該 LP 自己的 `sqrtPriceX96` relative price，不再使用可能被其他 pool 污染的 global USD graph。
- Production executor 尚未呼叫 Universal Router；目前只做到 quote / encoding / simulation tooling，所有 live rebalance writes 仍 hard-block。

### Full-live review blockers

目前監控、OOR hysteresis、PoolKey/range tracking、V4 quote 與 Universal Router calldata 已驗證；但正式 unattended live rebalance 仍需完成以下條件：

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

- 真實 LP membership 採 concentrated-liquidity 語義：`tick >= tickLower && tick < tickUpper` 為 In Range。
- `EDGE_BUFFER_TICKS` 只允許作 near-edge 監控提示，永遠不能授權撤 LP。
- 策略層：In Range 強制 `shouldRebalance=false`，並清除 OOR timer / deep confirmations。
- 排程層：pending rebalance 必須同時滿足 `outside===true && shouldRebalance===true`。
- BOT 執行前：重新從鏈上讀最新 tick；若已回到舊 range，記錄 `rebalance.blocked: absolute in-range hold` 並取消整輪。
- Executor 邊界再次讀取最新 PoolManager tick 並 fail closed；目前 live withdraw/swap/deposit 全部 hard-block，因此沒有單步 write 可繞過此 guard。
- 因鏈上價格可能在 RPC 檢查後、交易被打包前再次變動，正式 unattended live 啟用前仍需 atomic on-chain OOR guard 才能達到交易打包瞬間的絕對保證；目前 live auto-redeploy gate 維持關閉。

## v0.3.2 — 15 分鐘 OOR hysteresis（真實 Swap tick 回放校準）

2026-09-24 以錢包真實 Fables LP range，對 Robinhood Chain Uniswap v4 PoolManager `Swap` 事件的歷史 tick 回放：

- 回放 pools：CASHCAT/USDG 712 筆 Swap、USDG/ZZZ 115 筆、USDG/MOO 274 筆。
- 5 個真實 LP epoch 中，以 15 分鐘採樣共出現 4 次 OOR episode。
- 唯一自然回區間的 episode 是 MOO：最大只越界約 0.07%，15 分鐘後自行回區間。
- 舊 ZZZ / MOO 的明顯 breakout 最大越界約 3.87% / 9.88%，退出後 180 分鐘內也未觀察到回到舊 range。
- 目前採用：**每 15 分鐘才推進一次 OOR 決策狀態**；≤0.5% 最多等待 90 分鐘；>0.5% 必須連續兩次 15 分鐘採樣都成立才觸發 rebalance；任何時候回區間即清除 OOR timer。
- BOT 底層仍可每 15 秒刷新 topology/dashboard；因此快速監控與慢速策略採樣互不綁死。
- 回放工具：`npm run analyze:range-policy`，CI artifact 會產出完整 policy matrix。

## v0.3.0 — 動態 meme pair 接管 + 真實 TX 驗證

- 預設 `TARGET_MODE=wallet-active`：不再需要每次換 meme LP 都手動改 `TARGET_POOL_IDS`。
- 從錢包的 Fables `Deposited/Withdrawn` 事件建立 range candidates，再用 `rangeKey()` 完整 PoolKey 回配 registry pool。
- 只把 `ERC-6909 balanceOf(wallet, rangeId) > 0` 的 pool 放進 execution target；已退出的 pair 自動退役。
- execution pool 與 accounting pool 分離：舊 pair 的 wallet dust / 歷史資產仍保留在 PnL 帳本。
- 同一 pool 手動換 range、或跨 pool 換 meme 標的，都視為 topology handoff；預設 120 秒只監控、不自動交易。
- position / IL / fee state 全部改成 `poolId + rangeId` scope，避免多 pair 共用 hook 時互相污染。
- Fables shared hook fee event 若無法唯一還原 PoolKey，禁止猜測 pair 歸屬與重複計算；個人 fee 仍以 `userPosition.owed` / claim receipt 為準。
- 2026-09-24 真實錢包 TX integration smoke 已驗證：CASHCAT/USDG 退出後，BOT 自動移除 CASHCAT，並自動接管新 USDG/ZZZ 與既有 USDG/MOO。
- 真實 deposit TX 已驗證 Fables selector `0x36a9ca1a` 對應：
  `deposit((address,address,uint24,int24,address),int24,int24,uint128,uint128,uint128,uint256)`
- 三筆實際 deposit calldata 固定為 regression fixtures；deposit liquidity / amount caps 已納入 dry-run plan。
- Live rebalance fail-closed：完整 redeploy 未解鎖前，禁止先 withdraw 再停在半套狀態。

> 目前安全狀態：監控、動態換標的接管、v4 quote、deposit ABI 與 deposit dry-run plan 已驗證；**withdraw ABI 仍未解出（真實 selector 0x289a2a15），swap broadcast + 完整 redeploy transaction chain 仍未解除 live gate**。

## v0.2.1 新增

- Tight 新 range 的資產比例計算：自動判斷 0→1 或 1→0 需要交換多少。
- 直接呼叫 Robinhood Chain Uniswap v4 Quoter，對 Fables 的實際 PoolKey/hook 做 `eth_call` quote。
- `SWAP_SLIPPAGE_BPS` 產生 minOut，Dashboard 顯示下一筆預估 swap。
- 每 5 分鐘預設寫入一筆 `portfolio.snapshot`，保留 PnL / HODL / IL / fees / gas / Points 時序。
- Reference tx inspector 可選配 Blockscout API：抓 transaction / logs / internal tx / raw trace / verified ABI，自動定位 Fables `Deposited` hook call 與 candidate selector。
- 日常監控與 quote 仍然不依賴 Fables API；Blockscout 只用於歷史交易反解與 debug。

> 安全狀態：swap **報價與配平計畫已完成**；swap broadcast 與 Fables new-range deposit 仍 fail-closed，直到 reference transaction 的實際 execution manifest 被驗證。

## v0.2 重點

Fables 不提供可申請的交易 API 並不會阻擋這個 BOT。Fables 的 pool、range、fee 與交易結果都落在 Robinhood Chain，因此本專案把 **Robinhood JSON-RPC + Fables on-chain contracts/events** 當成 source of truth：

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

- 目前 LP + 錢包相關資產總值
- Net PnL
- HODL baseline
- vs HODL 損益
- Impermanent Loss / 無常損失
- LP fee 累積
- 未領 fees
- Gas fee（ETH / USD 估值）
- Fables Points：actual baseline + estimated delta
- 各 LP Range / current tick / In Range / Out of Range
- RPC health
- Execution / Dry-run / Pause 狀態
- append-only transaction / accounting ledger
- 手動 cashflow adjustment
- 手動輸入官方 Points baseline 校準

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
= Gross PnL - Gas Cost
```

如果 native ETH 本身就是 tracked target token，gas 已反映在 ETH balance 下降，因此不再重複扣一次。

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

BOT 讀兩層：

1. `userPosition().owed0 / owed1`：追蹤你個人的未領 fee 變化。
2. `claimFees` receipt / wallet token deltas：確認實際已領 fee。
3. `FeesCollected`：只有在事件可以安全歸屬到唯一 PoolKey 時才可作 pool-level denominator。多個 pool 共用同一 hook 時，v0.3 會 fail-closed 標記為 unattributed，避免重複計算與錯灌 Points。

第一次啟動只建立 user fee baseline，不把既有 owed fees 假裝成 BOT 期間新賺到的 fee。

## Fables Points

Fables UI 說明 Points 跟 LP 實際賺到的 swap fees 相關。v0.2 將 Points 分成：

- `actualBaseline`：你從 Fables leaderboard 看到的官方實際分數，可在 Dashboard 手動輸入。
- `estimatedDelta`：baseline 之後依 `你的 tracked fee / Fables 全市場 tracked fee` 推估新增分數。
- `estimatedTotal = actualBaseline + estimatedDelta`

這是 **估算器，不冒充官方 leaderboard**。如果官方 Points 邏輯或活動權重改變，只需調整 estimator；鏈上 fee ledger 不會因此失效。

## 快速開始

Node.js 20+：

```bash
npm install
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

Fables 新建 range 的 deposit ABI 已由 2026-09-24 三筆真實成功交易驗證；inspector 仍用來持續檢查 Fables 是否更換 selector / calldata：

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

目前研究 reference：

`0x4473378d0f20e03c647fe0d5b22a482b5700af7638578046d41396b5adf2dd30`

只有完成 target contract、selector、call trace、allowance、swap/deposit params、minted ERC-6909 shares 的驗證後，才解除 `ENABLE_AUTO_REDEPLOY` safety gate。

## Live mode 現況

目前 rebalance write path 全部保持關閉。尤其 `withdraw()` 先前假設的 ABI 已被真實 TX 否決；三筆手動 withdraw 都使用 selector `0x289a2a15`，在 exact signature 解出前 encoder 會直接 fail closed。

`claimFees()` 也不會由目前的 rebalance executor 自動送出；完整 state machine 驗證前不將任何單步 write 視為 unattended-safe。

每筆 live transaction 都會先：

1. wallet/private-key consistency check
2. gas guard
3. `eth_call` preflight
4. gas estimate
5. 送交易
6. 等 receipt
7. 記 gasUsed / gasPrice / gas ETH / gas USD
8. 記 token balance delta

### 重要

`withdraw -> swap -> deposit new range` **尚未解除 safety gate**。原因不是缺 Fables API，而是我們還沒有可靠證據確認 Fables 前端目前使用的 deposit/zap calldata。這個限制是刻意避免拿未知 ABI 動真實資金。

## Dashboard API

預設只綁 localhost：

- `GET /api/state`
- `GET /api/events?limit=200`
- `POST /api/control/pause`
- `POST /api/control/resume`
- `POST /api/control/scan`
- `POST /api/points/baseline`
- `POST /api/cashflow`

若 `DASHBOARD_HOST` 不是 loopback，程式強制要求 `DASHBOARD_TOKEN`。

## 測試

```bash
npm run check
npm test
```

v0.2：12 個 pure unit tests。

## 下一個 executor milestone

1. 用 managed/archive RPC 成功抓 reference deposit tx raw calldata。
2. 用 `debug_traceTransaction` 找到 router / hook / PoolManager internal calls。
3. decode Fables new-range deposit/zap ABI。
4. 建立 token-ratio calculator。
5. swap router allowlist + quote + minOut + deadline。
6. deposit `eth_call` simulation。
7. 小額 mainnet canary。
8. ERC-6909 share mint assertion。
9. 才允許 unattended full auto rebalance。

## 資安

- 不要提交 `.env` / private key。
- BOT 使用獨立 hot wallet。
- Dashboard 預設只開 loopback。
- live executor 只允許已驗證 contract / calldata 路徑。
- 所有 unknown selector 都 fail closed。
