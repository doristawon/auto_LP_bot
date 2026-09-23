# v0.2.1 — Execution Path

## 已完成

```text
Fables position
  -> OOR confirmations
  -> calculate new Tight ticks
  -> calculate target token0/token1 ratio
  -> decide 0->1 or 1->0 rebalance amount
  -> Uniswap v4 Quoter eth_call
  -> slippage minOut
  -> Dashboard / ledger rebalance plan
```

Quote 使用該 Fables pool 真實的 PoolKey（包含 hook），不是替換成其他 DEX 價格。

## Reference transaction reverse engineering

`npm run inspect:tx` 會依序：

1. 從 Robinhood RPC 讀 transaction / receipt。
2. 嘗試 `debug_traceTransaction` / callTracer。
3. 若設定 `BLOCKSCOUT_API_KEY`，補抓 logs / internal transactions / raw trace。
4. 從 `Deposited(address,uint256,uint128)` 找出實際 mint ERC-6909 range shares 的 Fables hook。
5. 從 trace 尋找打到該 hook 的 calldata，輸出 candidate selector。
6. 若 Blockscout 有 verified ABI，再自動 decode candidate function signature / args。
7. 完整 artifact 存入 `data/reference-tx/<hash>.json`。

## 為什麼還不自動 broadcast swap + deposit

目前我們已經可以正確回答：

- 新 range 是多少 ticks。
- 新 range 理想 token ratio。
- 需要交換哪一個 token。
- 約要交換多少。
- v4 Quoter 預估會收到多少。
- 依 slippage 最低可接受多少。

但 Fables 的 LP range 是 hook-managed ERC-6909，而不是標準 PositionManager NFT。沒有證據前直接猜 deposit/zap ABI 會讓 live wallet 承受不必要風險。

因此解除最後 safety gate 的必要條件是：

- reference transaction 能定位 deposit hook call；
- function selector + ABI 成功 decode；
- tickLower / tickUpper / recipient / amount constraints 可對照 UI 操作；
- approval / router path 確認；
- deposit 前 `eth_call` simulation 成功；
- 小額 canary 成功並確認新的 ERC-6909 shares mint。

達成後才將 `ENABLE_AUTO_REDEPLOY` 改成可用。
