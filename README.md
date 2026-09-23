# Auto LP Bot — Fables.fi / Robinhood Chain

> v0.2.1：API-less on-chain LP monitor + local control center + PnL / gas / fee / Impermanent Loss / Fables Points ledger + guarded rebalance executor.

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
2. `FeesCollected`：追蹤 Fables 全市場 pool fee，作 Points fee-share estimator 的 denominator。

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

Fables 新建 range / redeploy 的 deposit/zap ABI 在 v0.2 **仍不猜測**。先以已知成功交易做 trace：

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

目前可以安全開放的 write path：

- `claimFees()`
- `withdraw()`

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
