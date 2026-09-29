# Uniswap v4 換幣路由（MOO / ORBIO）

MOO 的 V3／V4 完整池地址、ETH 與 WETH 差異及 1–2k USDG 比價：
見 [MOO 換幣池核對](MOO_SWAP_POOL_RESEARCH.md)。

`EXTERNAL_SWAP_ROUTES_ENABLED=true` 時，機器人只對以下 Fables LP 的 USDG
交易對比較外部 Uniswap v4 池。LP 取出、存入及區間政策仍使用原 Fables 池。

| 代幣 | Fables LP PoolId | 可比較的外部 PoolId | 外部費率 |
| --- | --- | --- | --- |
| MOO | `0x6b187fad6ca2dcb913f2451c5d5e24d3d77b9d09ce272c2c99f64dac672bc485` | `0x85a3cd053eecbcf2a67fd2c391479a2267e237edcea3acf19609b329e3a482fa` | 2% |
| ORBIO | `0xc761f7de760d2b73cc3e3cc3d729916a4ed2f7fc6b0aa3872e2ced4258961e92` | `0xea9f200e13055b82f175f44f592c4c13dd8c9d9320a66487d3c5cd90d68550ef` | 0.8% |

兩個外部池的幣種合約、fee、tickSpacing、無 hook PoolKey 及 PoolId 雜湊均固定驗證。
路由先以同方向、同數量的鏈上 Quoter 報價比較；外部池至少多收到 20 bps
才會切換，以免小幅價格變化反覆改路由。選定池子後，配平搜尋只向該池報價，
避免每輪搜尋都翻倍消耗 RPC。選定的路由會套用到 Router calldata、逐筆交易
模擬與成交後核對；失敗時仍由既有執行狀態機保護資金。

此設定預設關閉。回復原本僅使用 Fables 路由：將本機 `.env` 設為
`EXTERNAL_SWAP_ROUTES_ENABLED=false` 並重新啟動服務。手續費標示不是最終
交易成本；尤其 MOO 的 2% 外部池可能比 Fables 動態報價差，應以實際到手量為準。
