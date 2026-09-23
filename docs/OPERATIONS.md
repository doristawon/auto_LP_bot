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

Dashboard `Pause execution` 只停鏈上執行，不停監控與會計。

也可以直接停止 process/container；ledger 已落盤。
