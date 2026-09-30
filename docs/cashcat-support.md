# CASHCAT/USDG 支援

Fables PoolId：`0x31608601d541e868706aa557558a4d4f99c57e6dd13bd3362edcf05d00a16212`。

中控台會從 Fables registry 發現此池，可在「池子監控與 APR」搜尋 CASHCAT 並儲存為指定再投入目標。每個錢包分別保存目標與執行狀態。

## Tight 區間與資產順序

此池的 tick spacing 為 60。現有 `buildFablesTightRange` 使用約正負 1% 的中心區間，再依 spacing 取整，總寬為 240 ticks。舉例：tick `-293888` 對應目標 `[-294000, -293760]`。這是未來重建時計算的範圍；儲存目標不會立即撤出現有 LP。

PoolKey 的 token0 是 CASHCAT，token1 是 USDG。換幣 anchor 與保留穩定幣零頭使用 token1，避免假設 USDG 必然在 token0。回歸測試會確認 PoolKey hash 與上述 PoolId 一致。

## 換幣路由

CASHCAT 尚未設定其他交易池，因此報價與換幣使用原 Fables 池；實盤仍須通過當次成本、滑點與交易模擬檢查。這項支援沒有加入拆單路由。其他池的較低名目費率不代表扣除價格影響與 Gas 後必然得到更好的成交。

策略研究文件中的歷史報價與收益推估不能當成當次可成交報價或未來收益。

## 驗證

`node --test test/cashcat-support.test.js` 涵蓋指定目標、PoolKey、Tight 240 ticks、USDG 在 token1 的資金分配，以及原 Fables 池路由。
