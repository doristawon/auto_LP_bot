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

`http://127.0.0.1:8787`

v0.5.0 Control Center 會顯示：

- tracked value / PnL / IL / fees / gas
- active LP、current tick、LP range、OOR excursion、OOR 持續時間
- deep OOR confirmations、rebalance eligibility、next target range
- signer / live writes / auto redeploy / EIP-7702 guard runtime readiness
- recovery journal、wallet topology cooldown、current block / RPC health
- 15 分鐘 range policy、0.5% threshold、90 分鐘 max wait、2 次 deep confirmation
- withdraw / swap / deposit slippage、max gas
- transaction / accounting ledger

控制項：

- `Refresh`：只重新讀取 dashboard API。
- `Scan now · no trades`：立即 fresh scan 鏈上狀態與 accounting，但強制 `executeRebalances=false`，不會送交易。
- `Pause execution / Resume execution`：只控制鏈上 execution，不停止監控。
- 每個 position 的 `Manual rebalance`：只會對「已經 OOR 且符合既定 policy」的 position 開放。

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

`DASHBOARD_TOKEN` 在以下任一情況必填：dashboard bind 到 loopback 以外、`ENABLE_LIVE_WRITES=true`、或 `DASHBOARD_MANUAL_CONTROL_ENABLED=true`。即使只綁 `127.0.0.1`，只要允許 capital-moving control 就不得留空。

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

看到 Fables leaderboard actual points 時，在 Dashboard 填入 actual points 並 Set baseline。

之後 Dashboard：

```text
Estimated Total = Actual Baseline + Estimated Delta
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
