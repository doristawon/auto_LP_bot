# MOO 換幣池核對（Robinhood Chain 4663）

執行 `npm run inspect:moo-routes` 可重新查詢 Uniswap V3 Factory、V3 池合約、
Uniswap V4 `StateView` 和兩版 Quoter；此指令唯讀，不載入錢包或 `.env`。
合約地址以 `src/execution/moo-pool-catalog.js` 為單一清單。MOO 固定為
`0xD9dB30BB0D2b8d2eae3826A1372117E058791e18`；USDG 是
`0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`；WETH 是
`0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73`。

## 池地址與現況

V3 地址是可讀取 `token0/token1/fee/liquidity` 的獨立池合約；下列各地址均由
Robinhood Chain Uniswap V3 Factory 的 `getPool` 核對。費率單位是百分比。

| 交易對 | 費率 | V3 pool 合約 | 核對時流動性 |
| --- | ---: | --- | --- |
| MOO/WETH | 0.3% | `0x4aF88fce3336B55C06ceb32DeFcE7B8d1d430f8C` | 0 |
| MOO/WETH | 1% | `0x9036A9406DAC1c252C364D037f489E5F0A752F54` | 有 |
| MOO/USDG | 0.01% | `0xBAC8c1487fc07e913f3588624246416B1688e2a3` | 0 |
| MOO/USDG | 1% | `0x3F711D7a3330bcC9302b2849BDA88c477E904F43` | 0 |
| USDG/WETH | 0.01% | `0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca` | 有 |
| USDG/WETH | 0.05% | `0x69BfaF19C9f377BB306a89aEd9F6B07e2c1a8d9a` | 有 |
| USDG/WETH | 0.3% | `0xa9188730Fe85Be88ad499D7d52B099e800fB0334` | 有 |
| USDG/WETH | 1% | `0x5f009E071F07e92B6C624e83F52F17bBDa34680D` | 有 |

上述三組交易對已查 V3 常見費率 `100/500/3000/10000`；未列出的
常見費率在 Factory 查不到池。報價工具每次會再查這些費率，若出現新池卻
沒有列入清單會明確報錯。非標準費率仍可能另有池，不能僅靠此檢查排除。

V4 地址則是 32-byte PoolId，**不是 V3 pool 合約地址**。以下 PoolKey 的
`currency0/currency1/fee/tickSpacing/hooks` 已由 PoolManager `Initialize` 事件核對，
並在工具中重新雜湊驗證。V4 `0x000…000` 代表原生 ETH，**不是 WETH**。

| 交易對 | 費率／類型 | V4 PoolId | 核對時流動性 |
| --- | --- | --- | --- |
| USDG/MOO | Fables 動態，近期 swap 約 3% | `0x6b187fad6ca2dcb913f2451c5d5e24d3d77b9d09ce272c2c99f64dac672bc485` | 有 |
| USDG/MOO | 無 hook 2% | `0x85a3cd053eecbcf2a67fd2c391479a2267e237edcea3acf19609b329e3a482fa` | 有 |
| USDG/MOO | 無 hook 3.94% | `0x50b29d336ff8c80656c9c2e811a82779f8b8064b46c99799cf61d20d096765c8` | 有 |
| USDG/MOO | 無 hook 5% | `0x3c38c0cb478ce74a8aba86f53267220f79ad050cbb49ea5851a428de39bc7bf0` | 淺 |
| USDG/MOO | 無 hook 8% | `0xd70cd268ac043ab2e4ec5dc1cdbd3cadf41dd466745025af3f687854f4d93075` | 淺 |
| ETH/MOO | 無 hook 1.0012% | `0x6132955c48b86c50fa83d8fa8ba74ad557c2e68c51bf23f2e44ba7937570f995` | 有 |
| ETH/MOO | 無 hook 1.0002% | `0x299cd9a098f3a7770a6c165b04a18a20f6949b0bfd4db3dfcb4682f66020f805` | 淺 |
| ETH/MOO | 無 hook 1.0003% | `0x2a06b51375754c76b2c95d1f07be0dc10d87de263a0d886bc0092eeed7c41166` | 0 |
| ETH/MOO | 無 hook 1.0018% | `0xa63de67bc27279bee51d2b1269c95b691f327f9d0699e74bcb5c471cb7206020` | 淺 |
| ETH/MOO | 無 hook 1.0016% | `0xbdfac4c62d44726fe56513ef3708427a908e6e142f75d44a7161966fd633f078` | 淺 |
| ETH/MOO | 無 hook 1.0015% | `0x4c59cf318f0b0692dfbb5488342afb5bdd77201386fa0c5a9a8c0fcf8b5ae8f1` | 淺 |
| ETH/MOO | 無 hook 0.99% | `0x5f202a8a27952912e584a8da1f7aa13a271b14cc4f1cdb58649b7c6b33dc568e` | 淺 |
| ETH/MOO | 無 hook 3% | `0x14fc21c0c33f88f6a08a4bfac790377bc40725b0e1c5476a251c6f456c94ae8c` | 淺 |
| ETH/MOO | 無 hook 1.0017% | `0x2fc12e8ad83507232f36a908ef08e875753fdfde26f1fb7ec2693bfcd72bacc9` | 淺 |
| ETH/MOO | 無 hook 5% | `0xf6a8a959422a373885f09afba6366d56b1a82de8db0daff6c88ba3fc5ea855c4` | 淺 |
| ETH/MOO | 無 hook 8% | `0x7bf3e49267ade1651d5299d1d6ac3bbad94120144989eb912776df5d49ece1a2` | 淺 |

候選來源另掃過 GeckoTerminal MOO 池清單第 1–3 頁；其中也有其他
DEX 的 V3 類池（例如 0.7%）及 Bankr 池，不能只看名稱便當作官方
Uniswap V3 Factory 的池。V4 可建立任意費率，以上是當次索引中
同配對且已核對 `Initialize` 的清單，未宣稱涵蓋未來新池。

MOO/MU `0xc3cc877a8a7d28efdb5dbec9ae71724652431e6411aa1a9fc8928028da554aa1`
屬 Bankr 路徑，沒有被當成 Uniswap V3 合約或 V4 PoolId 使用。

## 同區塊報價比較

區塊 `75408721`、同方向 exact-input 鏈上 Quoter 報價，未送交易。
USDG 買 MOO 最佳 V3 路徑為 `USDG → WETH (0.01%) → MOO (1%)`：

| 輸入 | Fables V4 直連 | V4 2% 直連 | V4 3.94% 直連 | V3 兩跳 | V3 相對 Fables |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1,000 USDG | 81,114 MOO | 78,851 MOO | 75,729 MOO | **81,877 MOO** | **+0.94%** |
| 2,000 USDG | 162,141 MOO | 155,461 MOO | 148,480 MOO | **163,034 MOO** | **+0.55%** |

以同路徑 1 USDG 小額報價為基準，V3 兩跳 1,000／2,000 USDG 的額外
價格衝擊約 **0.44%／0.88%**；兩跳名目費率合計 **1.01%**，已包含於
上述到手量，不能再次從報價扣除。V3 Quoter 的估計 gas 約 228k，Fables
V4 約 52k；gas 數字不是實際成交 gas，交易前仍應用當時 gas price 換算成本。
新增發現的 V4 5%／8% 直連池在約 1,000 USDG 時僅報出約 4.7 萬
MOO，約 2,000 USDG 時 Quoter 回報流動性不足；因此未放進上表的
可用路徑比較。

賣出方向不同：80,000 MOO 報價約 953.93 USDG（Fables）對
949.15 USDG（V3 兩跳）；160,000 MOO 約 1,906.86 對 1,890.24 USDG。
因此目前 **1–2k USDG 買 MOO 優先比較 V3 兩跳，賣 MOO 優先比較
Fables V4**。報價會隨市場與區塊變動，正式交易需重新報價及模擬。

目前實盤執行器仍只編碼 V4 換幣；此研究清單與工具不會使機器人自動
發送 V3 交易。V3 加入實盤路由前須另行完成 Universal Router V3 指令、
Permit2、撤池後逐筆模擬與成交核對，避免把 V3 合約地址誤作 V4 PoolId。

來源：[Uniswap Robinhood 部署表](https://github.com/Uniswap/contracts/blob/main/deployments/4663.md)、
[V3 Quoter 說明](https://developers.uniswap.org/docs/sdks/v3/guides/swapping/quoting)、
[V4 PoolManager Initialize 定義](https://github.com/Uniswap/v4-core/blob/main/src/interfaces/IPoolManager.sol)。
