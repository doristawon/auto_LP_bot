# Auto LP Bot — Fables.fi / Robinhood Chain

> v0.1 Safe MVP：自動監控 Fables 集中流動性區間、偵測 Out-of-Range、計算新的 Tight range，並對已驗證的 Fables 寫入流程提供安全閘門。

## 目標

此專案用來常駐監控 Robinhood Chain 上的 Fables.fi LP，核心循環是：

```
發現 Fables pool
  -> 讀取真實 PoolManager tick
  -> 找出指定錢包的 ERC-6909 range shares
  -> 判斷是否離開區間
  -> 連續確認 / 防抖 / cooldown
  -> 依 Tight preset 重新計算目標 ticks
  -> dry-run / preflight
  -> claim + withdraw
  -> swap 配平
  -> 重新 deposit 到新 range
  -> 繼續監控
```

### v0.1 已完成

- Robinhood Chain mainnet，chain id `4663`
- 從 FablesPoolRegistry `activePools()` 動態發現 pool，不硬編碼完整 pool 清單
- 讀取 Fables hook 對應的 canonical Uniswap v4 PoolManager
- 直接從 PoolManager state 取得 `sqrtPriceX96 / tick / liquidity`
- 透過 `Deposited(address,uint256,uint128)` 找出錢包曾建立的 range id
- 讀取 Fables ERC-6909 `balanceOf / rangeKey / userPosition`
- Out-of-Range 自動判定
- 預設連續 2 次 Out-of-Range 才觸發，降低瞬間穿價造成的重複搬倉
- Tight preset 預設約 `±1.2%`，並自動對齊 pool `tickSpacing`
- 每個 position cooldown
- 每小時最大 rebalance 次數
- JSON structured log
- 本地 state persistence
- RPC log 掃描首次回溯後只追新 block
- 已驗證的 `claimFees()` / `withdraw()` calldata
- transaction preflight、gas guard、wallet address/private key 一致性檢查
- **預設 `DRY_RUN=true`，不會動用資金**
- Node test / GitHub Actions CI / Dockerfile

### v0.1 刻意保留的安全閘門

Fables 的 LP **不是標準 Uniswap v4 PositionManager NFT**。目前公開資料可交叉驗證的是 Fables hook 自己維護的 ERC-6909 range shares，以及 `claimFees()`、`withdraw()`；但 Fables 網頁建立新 range 的 deposit/zap 寫入 ABI 與 swap 配平 route 還需要用實際成功交易再做 selector / calldata / trace 驗證。

因此 v0.1：

- 可以完整監控與自動產生新 range 計畫。
- 可以在明確開啟 live flags 後執行已驗證的 claim/withdraw。
- **不會猜測未知 deposit selector。**
- `ENABLE_AUTO_REDEPLOY=true` 目前會被程式阻擋，直到 deposit + swap executor 完成獨立驗證。

這是刻意的資金安全設計，不是以標準 Uniswap PositionManager 假裝相容。

## 已知 Fables / Robinhood Chain 基準

- Robinhood Chain RPC：`https://rpc.mainnet.chain.robinhood.com`
- Chain ID：`4663`
- FablesPoolRegistry：`0x159A113E012593D9B3cC63ad45E30F0467e13Ef3`
- Canonical Uniswap v4 PoolManager：`0x8366a39cc670b4001a1121b8f6a443a643e40951`
- USDG：`0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`
- CASHCAT/USDG FablesRamp hook：`0x08E52564Bad99E05a694b4809F397edcA417A080`

Registry 是 source of truth；新 pool 不需要靠 bot 發版才能被發現。

## 快速開始

需求：Node.js 20+。

```bash
npm install
cp .env.example .env
npm run once
npm start
```

預設設定已放入目前研究使用的監控錢包：

```env
WALLET_ADDRESS=0x6F196aF3B69c521eEd9436Abc9130699dF1c50bF
TARGET_SYMBOLS=CASHCAT,USDG
DRY_RUN=true
ENABLE_LIVE_WRITES=false
ENABLE_AUTO_REDEPLOY=false
```

如果首次掃描的 block 數太大，建議把 `LOG_FROM_BLOCK` 設成首次建立該 Fables position 之前的 block，可大幅減少啟動時 RPC request。

## Tight 策略

Fables UI 的 Tight preset 約為 `±1.2%`。v0.1 以目前 tick 為中心，先把價格寬度轉成 tick delta，再向外對齊 `tickSpacing`：

```
rawDelta = ceil(log(1 + 0.012) / log(1.0001))
lower = floor((currentTick - rawDelta) / tickSpacing) * tickSpacing
upper = ceil((currentTick + rawDelta) / tickSpacing) * tickSpacing
```

所以實際上下界可能因 tickSpacing 略微不對稱，這是正常的。

## 重要環境變數

| 變數 | 預設 | 說明 |
|---|---:|---|
| `DRY_RUN` | `true` | 只監控與產生 rebalance plan |
| `ENABLE_LIVE_WRITES` | `false` | 是否允許已驗證的鏈上寫入 |
| `ENABLE_AUTO_REDEPLOY` | `false` | v0.1 強制 gated |
| `TIGHT_WIDTH_BPS` | `120` | 單側 Tight 寬度，120 = 1.2% |
| `OUT_OF_RANGE_CONFIRMATIONS` | `2` | 連續幾次才觸發 |
| `POLL_INTERVAL_MS` | `15000` | 輪詢週期 |
| `MIN_REBALANCE_INTERVAL_SEC` | `300` | position cooldown |
| `MAX_REBALANCES_PER_HOUR` | `3` | churn guard |
| `ALLOW_ZERO_MIN_OUT` | `false` | live withdraw 是否允許 amount min = 0 |
| `MAX_GAS_GWEI` | `1` | gas guard |
| `POSITION_IDS` | 空 | 可手動指定 range ids，避開歷史 log discovery |
| `TARGET_POOL_IDS` | 空 | 可直接 pin pool id |

## Live mode

不要把 private key 寫進 repo。正式部署前至少完成：

1. 使用專門的 LP hot wallet，不使用主要資產錢包。
2. 先跑 `DRY_RUN=true` 至少跨過一次真實 Out-of-Range。
3. 驗證 bot 找到的 range id、shares、tickLower/tickUpper 與 Fables UI 一致。
4. 驗證 `claimFees` 與 `withdraw` preflight。
5. 完成 Fables deposit/zap 成功交易的完整 trace 與 ABI 驗證後，才解除 auto-redeploy gate。
6. 對 swap 設 maximum input / minimum output、deadline 與 token allowlist。
7. 對單次搬倉金額、每小時搬倉次數與 gas 設硬上限。

詳細內容見 `docs/LIVE_MODE_CHECKLIST.md`。

## 測試

```bash
npm test
npm run check
```

目前 v0.1 strategy tests：6/6 PASS。

## 下一階段

v0.2 的優先順序：

1. 反解並驗證 Surf 規劃中的成功交易 `0x4473378d0f20e03c647fe0d5b22a482b5700af7638578046d41396b5adf2dd30`。
2. 固化 Fables deposit/new-range ABI。
3. 加入 withdrawal 後的 token ratio 計算。
4. 導入可驗證的 Uniswap v4 / Fables swap executor 做資產配平。
5. deposit 前做 `eth_call` simulation + allowance + slippage + balance assertions。
6. 完成 `withdraw -> swap -> deposit` end-to-end fork / small-value live validation。
7. 加 Telegram / Discord 告警與 Prometheus health metrics。
8. 支援多個 target pool 與 `$INDEX` 等後續 Fables pool。

## 參考

- Fables： https://fables.fi/
- Robinhood Chain docs： https://docs.robinhood.com/chain/
- Fables registry / pool tracking 可參考 DefiLlama adapter
- Fables hook metadata 可參考 Uniswap hooklist
- vfat.tools 的 Fables range tracker 可交叉驗證 ERC-6909 range / withdraw 行為

---

此專案直接管理鏈上資產。先以 dry-run 驗證，再逐步開放寫入權限；任何未經 ABI / trace 驗證的 calldata 都不應進入 live executor。
