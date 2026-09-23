# Live Mode 上線檢查清單

v0.1 預設只允許 dry-run。正式開啟鏈上寫入前，逐項完成以下檢查。

## 1. Wallet 與權限

- 使用專門的 LP hot wallet。
- 不要使用主資產錢包。
- 私鑰只放在部署環境 secret，不寫入 repo、Docker image 或 log。
- 確認 `PRIVATE_KEY` 對應的 address 與 `WALLET_ADDRESS` 完全相同。

## 2. Read path

在 `DRY_RUN=true` 下確認：

- chain id = 4663。
- registry 可以回傳 target pool。
- bot 找到的 hook、pool id、token pair 與 Fables UI 一致。
- current tick 與 Fables / 其他鏈上工具交叉比對合理。
- range id、shares、tickLower、tickUpper 與實際錢包 position 一致。
- Out-of-Range 時 target range 會重新包住 current tick。

## 3. Anti-churn

至少保留：

- `OUT_OF_RANGE_CONFIRMATIONS >= 2`
- `MIN_REBALANCE_INTERVAL_SEC >= 300`
- `MAX_REBALANCES_PER_HOUR <= 3`

如果 pool 波動很高，優先增加確認次數與 cooldown，而不是縮短輪詢時間。

## 4. Claim / withdraw

目前 v0.1 只把已交叉驗證的 `claimFees()` / `withdraw()` 放進 live executor。

執行前：

- 先以 `eth_call` simulation 驗證 calldata。
- 確認 gas estimate 成功。
- 確認 deadline。
- amount0Min / amount1Min 不應長期使用 0；v0.1 必須另外顯式開啟 `ALLOW_ZERO_MIN_OUT=true` 才允許。
- 先用極小部位做一次真實交易。

## 5. Deposit / new range

**目前尚未解除安全閘門。**

解除前必須取得至少一筆 Fables 網頁成功建立 range 的真實交易，完成：

1. transaction input selector 解析。
2. target contract 驗證。
3. proxy / router / hook call trace。
4. decode token amount、tickLower、tickUpper、recipient、deadline、slippage/min amount。
5. approvals / Permit2 / router allowance 路徑。
6. deposit 後 ERC-6909 range share mint event 驗證。
7. 同一 calldata 使用 `eth_call` 或 fork simulation 重播成功。
8. 小額 mainnet validation。

不要直接用標準 Uniswap v4 PositionManager ABI 取代 Fables 寫入流程。

## 6. Swap / 資產配平

withdraw 後若需要 swap 才能符合新 range token ratio：

- router 必須 allowlist。
- token pair 必須 allowlist。
- maximum input / minimum output 必須硬限制。
- 設定 max slippage。
- 設定 deadline。
- quote 與 execution 必須使用同一 pool / route 假設。
- swap 後重新讀 balance，再計算可 deposit liquidity。
- 不允許無上限 approval；正式版應支援精確 allowance 或定期 revoke。

## 7. End-to-end

完整流程必須通過：

```
detect OOR
-> confirmations
-> claim
-> withdraw
-> wait receipt
-> read balances
-> quote rebalance swap
-> simulate swap
-> swap
-> read balances
-> build deposit calldata
-> simulate deposit
-> deposit
-> verify ERC-6909 shares
-> verify new range contains current tick
-> persist state
```

任何一步失敗都必須停止後續動作，不做盲目 retry transaction。

## 8. 監控與告警

正式版至少增加：

- heartbeat
- RPC failure counter
- position out-of-range alert
- rebalance started / completed / failed
- tx hash
- balance delta
- gas spent
- cooldown/rate-limit event
- panic stop / kill switch

下一版建議加入 Telegram/Discord + Prometheus。
