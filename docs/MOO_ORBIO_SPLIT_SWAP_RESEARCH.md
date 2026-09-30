# MOO / ORBIO 拆單路由研究

**結論：目前不啟用 atomic split，也不改現有單一路由選擇器。** 現有 MOO／ORBIO 候選路徑已由單筆 selector 以本次交易量報價與估算 gas 後選路；這次沒有拿到可驗收的最新完整報價矩陣，也沒有以實際 Universal Router calldata 完成 atomic split 模擬。跨獨立池拆分可能降低單池價格衝擊，但目前沒有足以證明它在 1,000／2,000 USDG 規模扣除完整 gas 後仍有淨收益的證據。

固定費率不會因同一池拆成數筆而降低。若費率為 `f`、總輸入量為 `X`，忽略整數捨入時，分拆後費用為 `f·x₁ + ... + f·xₙ = f·X`。拆單可能改變曲線成交價，但同池前筆會改變後筆可用狀態；把每筆都對初始 state 呼叫一次 Quoter 再相加，不能代表連續執行結果。舊附件的恆定 `L` 計算只可當近似模型，不能代替含前序 swap 狀態變化的逐筆模擬或真實 Quoter 執行證據。

## 候選路徑與可拆分條件

目前候選路徑依 repo 內 token、PoolId、V3 pool address 與路由設定整理。MOO 是 `0xD9dB30BB0D2b8d2eae3826A1372117E058791e18`；ORBIO 是 `0xaa07a0e9209e16ac99708c3ec70159c6ef3128a3`；報價輸入幣為 USDG `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`。

| 幣種 | 單筆候選路徑 | 可評估的不同池拆分 | 共享狀態限制 |
| --- | --- | --- | --- |
| MOO | Fables USDG/MOO 動態 V4；Uniswap V4 USDG/MOO 2%、3.94%、5%、8%；Uniswap V3 USDG/WETH 0.01%、0.05%、0.3%、1% → WETH/MOO 1% | 不同 V4 PoolId 可組成 2／3 路；一條 V3 bridge 可與不重疊的 V4 池組合 | 所有 MOO V3 bridge 都共用 WETH/MOO 1% pool，所以不能把兩條 bridge 當成獨立池 legs 一起加總 |
| ORBIO | Fables USDG/ORBIO 動態 V4；Uniswap V4 USDG/ORBIO 0.8%、2.8%、5%；Uniswap V3 USDG/ORBIO 1%；Uniswap V3 USDG/WETH 0.01%、0.05% → WETH/ORBIO 0.3% | 不同 V4 PoolId、V3 直池與不重疊的 V4 池可組合；可把一條 bridge 與未共用池的路徑組合 | 兩條 V3 bridge 共用 WETH/ORBIO 0.3% pool，不可當成彼此獨立的 legs |

跨池 split 的候選組合必須逐一比較整條路由所用的 pool set。V3 多跳路由只要任一 hop pool address 相同，就視為共享 state；V4 以 PoolId 判斷。不同 route label 本身不代表流動性獨立。每個 split leg 都要獨立計算 minOut；總和 minOut 不應取代實際 Router command 的逐 leg 失敗保護。

## 本次數值狀態

指定的核心矩陣如下。實際報價欄留空是刻意的：兩次有界唯讀快照都收到 Robinhood 公用 RPC HTTP 429，沒有產生完整 JSON；不以舊區塊數字、SURF 推算值或恆定 `L` 模型填補。

| 幣種 | 方向 | 規模 | 單一路徑到手量／minOut／Quoter gas | 不同池 2 路／3 路 | 結果 |
| --- | --- | --- | --- | --- | --- |
| MOO | USDG → MOO | 1,000 USDG | unavailable | unavailable | HTTP 429，沒有完整快照 |
| MOO | USDG → MOO | 2,000 USDG | unavailable | unavailable | HTTP 429，沒有完整快照 |
| MOO | MOO → USDG | 約 1,000 USDG 等值輸入 | unavailable | unavailable | HTTP 429，沒有完整快照 |
| MOO | MOO → USDG | 約 2,000 USDG 等值輸入 | unavailable | unavailable | HTTP 429，沒有完整快照 |
| ORBIO | USDG → ORBIO | 1,000 USDG | unavailable | unavailable | HTTP 429，沒有完整快照 |
| ORBIO | USDG → ORBIO | 2,000 USDG | unavailable | unavailable | HTTP 429，沒有完整快照 |
| ORBIO | ORBIO → USDG | 約 1,000 USDG 等值輸入 | unavailable | unavailable | HTTP 429，沒有完整快照 |
| ORBIO | ORBIO → USDG | 約 2,000 USDG 等值輸入 | unavailable | unavailable | HTTP 429，沒有完整快照 |

錯誤與空輸出留在 `artifacts/split-route-quotes-20260930.error.log`、`artifacts/split-route-quotes-throttled-20260930.error.log` 及對應的零位元組 `.json`。沒有從這兩次執行推導任何到手量、gas 淨收益或 minOut。`docs/MOO_SWAP_POOL_RESEARCH.md` 的數值屬舊區塊、僅 MOO 的歷史快照，不能當成本次 MOO／ORBIO 最新比較結果。

Surf 在這次研究中無法提供可用的 Robinhood SQL 佐證：相關查詢回覆 `PAID_BALANCE_ZERO`，依要求沒有重試；已安裝 catalog 也沒有 Surf skill 預期的 Robinhood dataset coverage 命令。SURF 尾段列出的多個換幣數量無法單靠分組數字辨識為多筆獨立交易、單筆 router 的多 route legs 或 log 分段，因此不作為拆單證據。文件不記錄私人錢包地址或帳務。

## Gas、費用與 minOut 的判讀

- Quoter 到手量已包含該路由各池費率造成的影響，不應再把名目 fee 從到手量重扣。用多池 split 時，每個 leg 仍各自支付其經過的池費。
- Quoter `gasEstimate` 是 route-level 估算，不是 Router 交易 receipt 的實際 gas。研究 script 對不同路由相加只能作初步成本篩選；不能當作 Universal Router 完整 calldata 的 gas 證明。若比較分開送出的交易，另列的額外交易 intrinsic gas 也只是下界，未涵蓋 chain／Router／command 開銷。
- Atomic split 是一筆交易內的多個 swap actions/commands，不等於多筆鏈上交易；它仍有每個 pool leg 的 fee 與 Router command gas。要判斷值得做，須以候選 Router 的實際 calldata 在同一 pinned block 模擬完整執行，取到每條路徑的實際 gas／minOut，並將前序 swap 對共享 state 的改變納入模擬。
- 當 RPC 可用時，script 會以 50 bps haircut 顯示每條 route／leg 的 minOut。這是研究用輸出，不代表已驗證完整 Router 對 aggregate 或逐 leg 最低量的執行語意。

## 重現與執行邊界

在 repo 根目錄執行：

```powershell
node scripts/research/simulate-v4-split-routes.js
```

`scripts/research/simulate-v4-split-routes.js` 是唯讀研究工具：固定 chain 4663，從 public RPC 取單一 block tag，核對 V3 每一 hop 的 Factory pool address，再呼叫 V3／V4 Quoter；不讀 `.env`、不建立 signer、不使用錢包、不 approve，也不送交易。輸入規模是 1,000／2,000 USDG；賣出方向以該 pinned block 的 Fables spot 價換算 token 數量。跨池 split legs 等量分配，整數除法剩下的最多 `n−1` 個 token base units 保留未用。

工具的 `eth_simulateV1` 呼叫目前只承載 Quoter calls，**沒有執行一串真實 swap 後再 quote 同池下一筆**，也沒有模擬完整 Universal Router split transaction。只有在所有 route 使用不同池且 pool set 確認不重疊時，初始 state 下各 leg quotes 的加總才適合作為初步獨立池比較；仍須另驗證 atomic Router 執行、費用與 gas。

2026-09-30 的兩次唯讀矩陣均收到 public RPC `429 Too Many Requests`，沒有完整快照。工具設有單次 request timeout、停用 ethers retry function，並序列節流；遇到 HTTP 429 後不再重跑本研究。Surf `PAID_BALANCE_ZERO` 同樣不重試。

## PM 驗收結論

目前維持實盤單一路由 selector。**不建議現在啟用或實作自動拆單。** 對「同一固定費池拆成多筆不會降低比例手續費」信心高；對「不同獨立池拆分可降低曲線衝擊」屬合理但只限路由報價假設；對 MOO／ORBIO 1k／2k 實際扣完 Router gas 後的淨收益沒有可用數據，無法給出正收益結論。需等 RPC 限流解除後取得同區塊 Quoter 表，再以真實 Router calldata 做 stateful simulation，結果顯示跨池淨收益穩定且高於 gas／minOut 誤差，才交由 PM 評估實作。

參考： [Uniswap Auto Router V2](https://blog.uniswap.org/auto-router-v2)、[Uniswap routing 說明](https://support.uniswap.org/hc/en-us/articles/46932289118733-How-does-routing-work)、[Geth `eth_simulateV1`](https://geth.ethereum.org/docs/interacting-with-geth/rpc/ns-eth)。
