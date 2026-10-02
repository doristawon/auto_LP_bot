# Fables 官方 Rebalance / Zap Router 呼叫研究

查核日期：2026-10-02（台灣時間）。本次唯讀研究，未簽名、未授權、未廣播交易；未更換 Bot 的實盤執行路徑。

## 結論

官方部位頁的 **Rebalance** 按鈕透過 Zap Router 的 `reposition(p, r)` 執行，並非呼叫一個 REST `/rebalance` 端點。前端自行編碼 calldata，以 RPC 模擬，再由錢包 `eth_sendTransaction` 送出。Bot 可用 ethers 直接建構及呼叫相同合約方法，不需要操作網頁。

官方設計可將同池的撤出舊區間、換幣、存入新區間放在同一筆交易，並透過 `add0` / `add1` 加入額外錢包資金。這可進一步合併目前 Bot「撤池一筆、換幣＋加池一筆」的流程。首次授權仍可能另外需要交易。

## 已確認的部署資訊

在 Robinhood Chain（chain ID `4663`）區塊 `77937715` 唯讀查核：

| 項目 | 結果 |
| --- | --- |
| 官方 Zap Router | `0x89d862d7a189627B229aa3Ac28Ae565f6Fb89d1f` |
| `reposition` selector | `0x7ff314f0` |
| Runtime code 大小 | 40,313 bytes |
| Runtime code keccak256 | `0x92ba1c510d3aa52ad14a29cc41a74374405d4c881b08b176cc11b0accfa2cbbb` |
| `fees()` 的 `feeBps` | `5`，即 0.05% |
| CASHCAT hook | `0x08E52564Bad99E05a694b4809F397edcA417A080` |
| `isFablesHook(CASHCAT hook)` | `true` |

ABI 已從官方公開 JS 的純資料 literal 擷取；未執行下載的前端程式。部署地址來自首頁 bundle export `c7`，不是自行猜測。

## 呼叫參數

`reposition` 接受兩個 tuple：

| 參數 | 說明 |
| --- | --- |
| `p.key` | 完整 PoolKey：currency0 / currency1 / fee / tickSpacing / hooks |
| `p.oldLower`, `p.oldUpper`, `p.shares` | 舊 LP 區間與欲移動的 ERC-6909 shares |
| `p.newLower`, `p.newUpper` | 新區間邊界，必須符合 tickSpacing |
| `p.minLiquidity` | 新 LP 最低 liquidity，須由模擬結果與滑點限制計算 |
| `p.deadline`, `p.recipient` | 到期時間與收款錢包 |
| `p.add0`, `p.add1` | 額外一起投入的錢包 token0 / token1；單純移倉可為 0 |
| `r.legs` | 換幣路徑；可包含型別化 V4 route 或官方允許的 aggregator calldata |
| `r.maxFeeBps` | 本次允許的 Router 費率上限 |

官方無額外加倉的預設設定是 `add0=0`、`add1=0`。前端先讀價格、Router fee 與 hook 支援狀態，再比較原生路徑、替代 V4 路徑與可用的 aggregator 路徑；不是只將 ticks 改掉。

## 授權與模擬

- 原 LP 是 ERC-6909 shares；官方呼叫 hook 的 `approve(router, rangeId, shares)`，不是 ERC20 的兩參數 approve。
- 純移倉時，直接送 Router `reposition`；若包含 ERC20 額外資金，官方另走 Permit2 token approval、EIP-712 batch signature 與 `withPermit2` 包裝。
- 新使用者在網站端另有條款與 Zap notice 的 `personal_sign`，送至 `/api/consent`、`/api/zap-consent` 保存同意紀錄。這些 HTTP 端點不是交易執行 API；整合時仍應依官方使用條款處理同意。
- 官方以 `eth_simulateV1` 檢查整筆交易，確認唯一 `Repositioned` 事件、recipient、liquidity、退款與換幣方向，再填入最低 liquidity。
- 前端目前預設滑點 50 bps；價格影響達 500 bps、退款比例達 100 bps 會擋下操作。這是觀察到的網站前端規則，不代表合約本身或 Bot 必須使用相同數字。
- 同池方法只接受一個 PoolKey，不能直接當成 CASHCAT → MOO 的跨池換倉 API。

## 費用與帳務差異

官方程式說明：Router 費僅針對在 Fables 市場外執行的換幣金額；全程留在 Fables 市場則 Router 不抽成。鏈上當時設定為 5 bps。**這不會免除 underlying pool 的交易費或價格影響，也不能把 Fables 的動態池費視為 0.05%。**

官方移倉頁明確顯示 `Earned fees stay claimable.`：已累積手續費仍留在原區間可領取。因此不能把官方 `reposition` 當成目前 Bot `withdrawAndClaim` 的同等替換。必須保存舊 range 的待領 fees，避免漏計或重算；如要一起收費再投，另規劃合約呼叫順序。

官方 Zap notice / 條款目前明確寫出 Router 尚未有 external audit。本次只確認網站使用方法、部署 bytecode 與唯讀 getter；未取得完整合約來源審查、未完成本錢包 `reposition` 全流程模擬，也未證明實盤交易成功。

## Bot 整合建議

1. 新增獨立官方 Router adapter，先用既有 OOR 15 分鐘確認政策挑選同池新 Tight 區間；目前執行器保留作回退。
2. 固定 chain/address/code hash；驗證 registry PoolKey、shares、recipient、deadline、成本與最低 liquidity。
3. 模擬正式批准與完整 reposition 呼叫，將受保護 USDG / ETH 保留額排除在 add0 / add1 外；以新倉＋退款的淨值選路徑。
4. 若仍要求上鏈當下禁止撤出區間內 LP，現有 guard 只有 guardedWithdrawAndClaim / atomicSwapAndDeposit，需新增受限 Router 包裝方法；不能直接呼叫 Router 後宣稱原 OOR 合約閘門仍有套用。
5. Journal 改成單一資本交易階段，核對 Repositioned、old/new range shares、餘額與舊倉待領 fees；交易結果不明時禁止第二次送出。
6. 先完成唯讀實倉模擬與受影響測試，再於正常 OOR 時驗收一筆官方再平衡。研究完成不等於已啟用。

## 原始來源

- [官方部位頁](https://www.fables.fi/portfolio/cashcat-usdg/-294000/-293760)
- [官方 RepositionSheet bundle](https://www.fables.fi/assets/RepositionSheet-C7FJDFCn.js)
- [官方 Zap 編碼、ABI、模擬與授權程式](https://www.fables.fi/assets/zap-quote-Cc8HQiTB.js)
- [官方部署地址 bundle](https://www.fables.fi/assets/index-C1gUYmA7.js)
- [官方條款](https://www.fables.fi/terms)

本機研究資料與鏈上讀回存放於 git-ignored `artifacts/fables-rebalance-research/`；公開文件未包含任何私鑰、私人 RPC 或錢包資產資料。
