# 系統架構與目前執行狀態

## 多錢包執行

`WalletFleet` 為每個錢包建立獨立的 `AutoLpBot`、signer、執行迴圈、目標池、帳務、Points 與交易復原紀錄。中控台以 `X-Wallet-Address` 固定每個請求的操作對象；切換檢視不會改變其他錢包的執行狀態。

主要錢包沿用原 `.env`；額外錢包存於受 ACL 保護且由 Git 忽略的 `.env.wallets.json`。每個地址各自完成 EIP-7702 授權與實盤檢查。新增錢包預設暫停，重啟先完成鏈上掃描，再恢復原本已啟動的錢包。

RPC 清單共用，變更前需等待所有錢包的交易與背景掃描結束，避免已移除的端點繼續被舊掃描使用。端點透過不含網址的隨機 ID 管理；頁面讀取快取的健康狀態，手動檢測才額外發出測速請求。實際交易仍會重新驗證必要條件，不使用中控台的 guard 快取代替交易檢查。

## 資料來源與服務依賴

鏈上部位、range、餘額、PoolManager 狀態與交易收據由 Robinhood Chain RPC 提供。市場 APR、TVL、成交量／手續費統計與官方 Points 結算則使用 Fables 公開資料來源；錢包費用佐證也會比對 Fables 索引資料。

| 資料 | 來源 | 不可用時的行為 |
|---|---|---|
| Active pools、PoolKey、hook、current tick | Fables Registry 與 Uniswap v4 PoolManager，透過 Robinhood Chain RPC | RPC 狀態讀取失敗時該狀態不可用，執行流程採 fail-closed |
| Range id、ticks、wallet shares、owed fees | Fables hook 合約，透過 Robinhood Chain RPC | 不猜測缺漏狀態或部位歸屬 |
| ERC20/native balance、交易收據、gas | Robinhood Chain RPC | 缺少必要證據時不宣告流程完成 |
| Pool TVL、成交量、手續費、池級 APR | Fables 公開市場統計 | APR 留白；依 APR 選跨池再投入目標會停止 |
| 官方 Points 結算、錢包費用佐證 | Fables 公開資料／索引來源 | 官方基準或佐證標示不可用，不把暫估冒充官方結果 |
| 交易 quote | Uniswap V3／V4 Quoter，透過 Robinhood Chain RPC | quote 或模擬失敗時不進入對應交易階段 |

因此鏈上部位監控與帳務的基礎資料來自 RPC，但完整市場 APR、官方 Points 與 fee evidence 仍依賴 Fables 公開資料來源。專案不使用 Fables 私有交易 API、API key 或網頁 DOM。

## RPC strategy

### Development

Robinhood public RPC + 可設定的監控週期。

### Production

- Primary：managed Robinhood RPC，例如 Alchemy / QuickNode / Chainstack。
- Secondary：另一家 managed provider。
- Last-resort：Robinhood public RPC。
- historical/backfill：archive-capable endpoint。

啟動及變更端點時會驗證 chain id 與區塊高度；第一個健康端點作為 write provider。讀取備援不代表交易送出端點已具備 archive 能力。

## Data model

append-only ledger 優先於只存 mutable state：

```text
on-chain events ─┐
bot tx receipts ─┼─> events.jsonl ─> analytics ─> latest-snapshot.json ─> dashboard
manual cashflow ─┤
points baseline ─┘
```

這讓 PnL 可以重建，也方便後續 migration 到 SQLite/PostgreSQL。

## PnL decomposition

Dashboard 分開顯示：

- Token market PnL
- LP principal
- Unclaimed fees
- Lifetime tracked fees
- Gas
- External cashflow
- Impermanent Loss vs HODL
- Excess return vs HODL
- Estimated points

估值結果受價格來源與資料覆蓋限制；無法可靠定價時會顯示缺值，不能把它當成精確收益。

## Points estimator limitations

- 鏈上費用與全市場 swap evidence 用於 Points V2 暫估。
- Fables 官方結算分數是官方基準；手動備援值只在官方資料不可用時顯示，不會覆蓋官方基準。
- 分母覆蓋不完整或缺少必要 Fables evidence 時，估算會標示為暫估或不可用。

## Fail-closed execution

`claimFees`、`withdraw`、`swap`、new range 與 `deposit` 的執行程式碼已實作。這不代表 live mode 預設已啟用：簽署器、live-write flags、guard 的部署與當前錢包 canary 驗證，以及 recovery gate 都必須同時通過。正式啟用前請依 [Live Mode Checklist](LIVE_MODE_CHECKLIST.md) 完成逐項驗收；任一必要證據不可用時應停止資產移動。


### 每錢包兩池資金配置

Dashboard allocation GET/PUT 路由依目前選取的錢包 bot 處理。讀取只回傳 bot 快取，不會觸發 RPC。寫入會驗證啟用狀態、支援的池 ID、唯一性，以及總和為 10,000 的整數 basis points。資金估值只透過既有掃描／估值週期更新，因此設定儲存後，預算可能標示待更新。配置模式保留各池自己的 OOR 處理，並略過舊單池目標／APR 流程；不會把錢包地址或池 ID 寫死在 dashboard source。

Dashboard allocation GET/PUT routes resolve the currently selected wallet bot. Reads expose the bot's cached allocation snapshot and must not trigger fresh RPC reads. Writes validate enabled state, supported pool IDs, uniqueness, and integer basis-point weights totaling 10,000. Fresh capital values update only through the existing scan/valuation cycle, so a saved strategy can be active while its budget is pending refresh. Allocation mode preserves pool-local OOR handling and bypasses legacy single-target/APR behavior. The dashboard does not hardcode wallet addresses or pool IDs.
