# 官方 Reposition 成本比較與 Bot 整合

查核日期：2026-10-02。原始錢包收據、帳務與 RPC 演練保存在本機忽略的 `artifacts/reposition-cost/`；這份文件只保留方法與摘要。

## 成本結論

官方 `reposition` 並非必然更省。三次實際官方操作的 Gas 分別為 2,194,263、2,146,342、1,732,725；近期 Bot 的撤池與 atomic 換幣加池合計為 1,586,549。依各次實付 Gas 價格，官方單筆比該 Bot 週期多約 37.3%、32.4%、8.25%，還沒包含另行 Claim 的成本。不同操作的金額、方向與市場狀態不同，這不是同區塊的反事實比較。

官方前兩次走外部 Kyber 路徑，Router 另收換幣輸入的 5 bps（0.05%）；`Routed.fee` 與 `FeeTaken` 表示同一筆費用，不可重複加總。第三次未收這筆 Router 費，但仍發生 Fables 池內換幣，並非免交易費。

實際 Fables `Swap.fee` 曾為 3,127 pips（0.3127%），Bot 近期操作曾為 3,283 pips（0.3283%）。設定的 3.5% 是允許的成本上限，不是每次實際池費。官方外部路徑可使用 Ramses V3 的 0.125% CASHCAT／USDG 池或其他 venue；Ramses Factory 與 Bot 已支援的 Uniswap V3 Factory 不同，不能把地址直接塞進 Uniswap Router。

一份 2,000 USDG 當前候選報價顯示 Kyber 比原 Fables 路徑多約 0.55% 的 CASHCAT 輸出；報價不是同區塊、也不是成交，因此只支持加入候選路徑。是否採用由執行前完整模擬決定。

正式候選程式的同區塊模擬也已完成：既有流程 Gas 為 1,729,521，官方原生為 2,699,431，官方 Kyber 為 3,658,584；扣 Gas 並排除額外歷史 Claim 後，官方兩條路徑分別少約 0.168 與 0.346 USDG，未達約 0.440 USDG 的最低改善門檻，因此選路器保留既有流程。這次驗證使用真實池價與暫時的 OOR marker／候選 guard code override，沒有廣播交易；不是實際成交成本。官方模式目前維持關閉，v3 guard 尚未部署或委派。

## 選路方式

1. 維持原 OOR 確認政策。區間內持倉不因比較成本而撤出。
2. 在任何資本交易前模擬既有撤池＋atomic 加池路徑，取得新 LP、完整錢包餘額及 Gas。
3. 比較官方原生路徑與新鮮 Kyber 路徑。費用 Claim、批准、Permit2、撤出、換幣、再投入與撤銷多餘批准均納入同筆 guard 模擬。
4. 以同一參考價格衡量新 LP＋餘額，扣 Gas；歷史未領費用若由官方候選額外領出，從比較增益扣除，避免把自己的既有資產誤算成節省。
5. 只有完整模擬通過、餘額受保護、換幣成本在限制內且淨結果優於既有流程時使用官方路徑。外部報價不可用或比較未通過時，資本交易開始前維持既有流程。
6. 官方交易一旦產生已保存的 hash，結果不明就鎖定 recovery；不再送第二筆替代資本交易。

## 手續費與 LP 事件

官方網站 `reposition` 會讓原 range 的 earned fees 保持可領取；它本身沒有自動 Claim。Bot 的新 guard 先領取同池當前與符合條件的歷史 range 費用，再一起投入新區間。Claim 使用實際淨入帳額；Lens 的有效 Claim 費率亦需納入成本。

官方 `Deposited` 的 owner 是 Router，接著用 ERC-6909 `Transfer` 把 shares 交給錢包。只搜尋錢包直接 `Deposited` 會漏掉這種 LP。部位探測需在已驗證 hook 上搜尋進出錢包的 ERC-6909 Transfer，並用 `rangeKey` 與 `balanceOf` 確認實際部位；不可把普通 ERC20 Transfer 當成 LP。

## 設定與相容性

- `OFFICIAL_REPOSITION_ENABLED` 預設 `false`。
- `OFFICIAL_REPOSITION_WALLETS` 限定採用新方法的錢包。
- `OFFICIAL_EIP7702_GUARD_ADDRESS` 必須是已部署、核對過的 v3 implementation。
- 既有 atomic 換幣加池與其他錢包的 guard pin 保留；跨池換倉與兩池分配繼續走既有執行器。
- 第一版官方候選限 USDG 為 currency1 的 Fables 同池部位；其他配對保留既有流程。
- v3 保留原有 guard 方法；新增同池官方方法與 Permit2 所需的 ERC-1271 簽章驗證。委派 EOA 有程式碼，Permit2 會使用 contract-signature 分支。
- ETH Gas 保留額、USDG 保留額、手動暫停狀態、停損比例與原停損本金基準均維持。

## 驗證界線

本機單元測試覆蓋候選成本、收到唯一新倉事件、單筆資本交易、暫停及未知廣播 recovery。RPC 演練先以暫時的 guard code 與 OOR marker override 驗證，再以真實 OOR 狀態、只覆寫候選 guard code，跑真實 Router、Hook、Kyber、Claim 與 Permit2；這不廣播、不撤出真實區間內 LP，也不等於已完成實盤官方再平衡。正式路徑仍須在真實 OOR 且 Bot 執行時重新模擬與核對收據。

## 原始來源

- [Fables 官方 Reposition／Zap 研究](FABLES_OFFICIAL_REBALANCE_RESEARCH.md)
- [官方 Zap 編碼、ABI、模擬與授權程式](https://www.fables.fi/assets/zap-quote-Cc8HQiTB.js)
- [官方部位頁](https://www.fables.fi/portfolio/cashcat-usdg/-294000/-293760)
- [Uniswap Permit2 SignatureVerification](https://github.com/Uniswap/permit2/blob/main/src/libraries/SignatureVerification.sol)
- [官方區塊瀏覽器](https://robinhoodchain.blockscout.com)
