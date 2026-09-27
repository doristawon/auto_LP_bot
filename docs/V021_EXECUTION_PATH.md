# v0.2.1 Execution Path（歷史設計備註）

本文件保留 v0.2.1 的設計背景。當時 executor 只產生 swap quote 與配平計畫，並將 swap broadcast、new-range deposit 列為待解鎖項目；該限制已由後續版本的 receipt-reconciled executor 取代。

目前程式已實作下列流程：

```text
fresh OOR recheck
  -> guarded withdrawAndClaim
  -> wait receipt and reconcile actual wallet deltas
  -> quote / simulate exact-input swap when required
  -> verify swap receipt and exact spend
  -> recompute target range and liquidity from current balances
  -> preflight and deposit into Fables hook
  -> verify receipt, PoolKey, ticks, and ERC-6909 shares
```

實作存在不等於可直接 live 執行。`DRY_RUN=true`、`ENABLE_LIVE_WRITES=false`、`ENABLE_AUTO_REDEPLOY=false` 是預設安全設定；live activation 還需要針對當前 signer 的 guard 驗證及 recovery readiness。請以 [README](../README.md) 和 [Live Mode Checklist](LIVE_MODE_CHECKLIST.md) 的目前說明為準。