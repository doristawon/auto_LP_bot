# Fable 5.1 架構審查修正

2026-10-01：使用 WSL Devin 的 `claude-fable-5-1-max` 完成整份公開原始碼架構審查。完整 session export 與報告保留在本機 artifacts；公開文件只記錄修正，不包含錢包、RPC 憑證或帳務資料。

## 本次修正

- 單池切換可等待掃描完成；等待時禁止新資金操作。若策略已暫停且只有唯讀掃描，可直接停用雙池設定。停用配置不再受舊池流動性或暫停狀態阻擋，前端確認儲存結果並顯示分類錯誤。
- 窄區間存入以 tick 價格範圍計算可承受的 liquidity 與代幣上限。`DEPOSIT_TICK_TOLERANCE=-1` 自適應，`0` 保留原計算，正整數指定範圍。
- 已授權的存入 caps 固定；實際存入重新模擬最終 calldata，只能降低 liquidity。雙池 bootstrap 不在換幣後增加 caps 或重新擴大授權。
- 每池 bootstrap／top-up 失敗個別退避，5 分鐘起、最長 30 分鐘；需要復原時自動暫停，避免整個監控週期反覆失敗。
- 同池多筆 LP 可挑選區間內且 shares 最大的部位加倉。退避中的池不阻擋另一池。
- 僅在確定交易回滾、歷史及最新餘額與 shares 未變、沒有 pending nonce 或先前資金移動時，允許有限次重試。結果不明仍鎖住。
- 啟動時只對帳沒有資金交易 hash、沒有未確認廣播、沒有 pending nonce 的中間 journal；其餘必須復原。
- 存入失敗後重用既有雙邊資產的標記有效一小時，且兩側都須達最低資金門檻；不為零頭鑄造小額 LP。
- inspect:recovery 支援 routeSwaps hash 陣列。dry-run bootstrap 留下帳務預演紀錄並節流。PowerShell explorer 子程序不繼承 signer 私鑰環境。
- 雙池週期使用本輪既有資產掃描結果，僅在成功執行後重新掃描，減少重複 RPC。

## 驗證界線

回歸測試覆蓋單池切換、等待與資金寫入阻擋、tick 範圍 caps、確認回滾的餘額／shares／nonce 條件、啟動 journal、每池退避及 recovery hashes。測試不以真實交易作為驗證手段。

## 後續優化

歷史 range 候選退役、執行期 RPC 自動健康切換、每池獨立倒數及跨池超額資產整理仍可分別優化。這些項目不代表本次已實作；RPC 可透過現有中控台檢測及移除。啟用實盤前仍應使用 verify:guard 驗證目前簽署錢包。
