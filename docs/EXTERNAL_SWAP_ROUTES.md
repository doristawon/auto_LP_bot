# MOO / ORBIO 實盤換幣路由

`EXTERNAL_SWAP_ROUTES_ENABLED=true` 時，機器人在 MOO 或 ORBIO 的 USDG 交易對換幣前，
以本次實際交易量取得鏈上報價，檢查價格衝擊與最低到手量，並比較估計 gas 後選擇路徑。
LP 區間、提款、存款仍在指定的 Fables 池。其他代幣配對沿用原路由。

| 代幣 | 候選路徑 |
| --- | --- |
| MOO | Fables USDG/MOO；Uniswap v4 USDG/MOO 2%、3.94%、5%、8%；Uniswap v3 USDG/WETH 0.01%、0.05%、0.3%、1% → WETH/MOO 1% |
| ORBIO | Fables USDG/ORBIO；Uniswap v4 USDG/ORBIO 0.8%、2.8%、5%；Uniswap v3 USDG/ORBIO 1%；Uniswap v3 USDG/WETH 0.01%、0.05% → WETH/ORBIO 0.3% |

V3 路由逐跳核對 Factory 回傳的 pool 合約地址；V4 路由核對 PoolKey 與
PoolId 雜湊。幣種合約與 Fables 來源池也固定核對，避免同名代幣或錯池。
MOO 的 V3 USDG 直池及 WETH/MOO 0.3% 路徑在本次同區塊掃描均報價 revert，
目前排除在實盤候選外，避免每次交易重複消耗 RPC 額度。
報價失敗或超過價格衝擊上限的路徑會被排除。跨池換倉與加倉仍保留現有的
逐筆模擬、滑點、gas 預算、allowance、成交餘額及故障復原檢查。

選路時優先比較預估淨到手美元價值，扣除 Quoter 回傳 gasEstimate × 設定的
`MAX_GAS_GWEI` × ETH 價格及 25% 緩衝；若沒有足夠的 USD 價格資料，改比原幣
到手量。外部路徑須比 Fables 基準有實質優勢才切換。配平搜尋只在選定路徑上
報價，送單前再以實際數量重掃候選路徑。Quoter gas 是估計值，最終交易成本仍
以鏈上 receipt 為準。

唯讀現場掃描：`node src/tools/inspect-executable-routes.js`，使用公用 RPC，不讀
`.env` 或私鑰，列出兩個交易對的雙向候選路徑與到手量。若公用 RPC 限速，該次
掃描會失敗；實盤選路仍使用已設定的 RPC。

回復原本僅使用 Fables 路由：將本機 `.env` 設為
`EXTERNAL_SWAP_ROUTES_ENABLED=false` 並重新啟動服務。MOO V3／V4 池地址與費率
另見 [MOO 換幣池核對](MOO_SWAP_POOL_RESEARCH.md)。
