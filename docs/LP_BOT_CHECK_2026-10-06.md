# LP Bot 檢查報告（2026-10-06）

檢查範圍：`/mnt/d/Codex_Project/WEB3/LP_BOT`（Windows：`D:\Codex_Project\WEB3\LP_BOT`），版本 `auto-lp-bot` 0.6.0。

檢查時間約為台灣時間 2026-10-06 22:40。沒有讀出 `.env`、私鑰或私人 RPC，也沒有送出任何實盤交易。程式沒有修改。

## 結論

主錢包 `0x2Ea3…De6e` 的 PONS/USDG 再平衡已在撤池後停住。原子存入沒有送出，執行維持暫停，自動停損目前也不會動作。中控台本身是活的。語法檢查通過，單元測試 534 項全部通過。

## 目前運行狀態

Windows 上的 bot 從台灣時間 2026-10-06 12:35 跑到檢查當時。`http://127.0.0.1:18087/api/health` 回 HTTP 200：`ok=true`、`running=true`，兩個錢包都在跑監控。WSL 裡的 `127.0.0.1:18087` 連不到，是 WSL2 和 Windows localhost 分開，不是中控台掛了。

程式預設埠是 8787。這個程序實際使用 18087。8787 當時被另一個本機服務占用。

| 錢包 | 實盤旗標 | 執行 | 復原鎖 | 目前部位 |
|---|---|---|---|---|
| `0x2Ea3…De6e` | 實盤已開啟 | 暫停 | 要復原 | PONS/USDG，新區間，價格在區間內 |
| `0x6F19…50bF` | 實盤已開啟 | 暫停 | 無 | 沒有 LP；目標顯示 CASHCAT/USDG |

## 主錢包這次發生什麼

台灣時間 18:06 開始對舊的 PONS/USDG 部位做再平衡。順序是對的：先做 8 筆 Permit2 授權並確認，18:10 的 `guardedWithdrawAndClaim` 成功（收據 status 1，區塊 81549222）。撤池前的整段模擬曾通過，換幣衝擊約 86 bps。

撤池之後的 `atomicSwapAndDeposit`（selector `0xaa8c6950`）只做了 `eth_call`，沒有廣播。重試過程：

1. 第一次預檢回 `ExcessResidual`（`0x6af2a037`）。
2. 重擬合後回 `LiquidityBelowMinimum`（`0xb6470697`）。
3. 事件列表寫成 `unknown custom error`。日誌裡已解出的原因是：「價格變動使可存入流動性低於最低限制；尚未送出存入交易。」

18:12 日誌進入 `recovery_required`，執行暫停，沒有待確認交易。18:14 監控看到舊池部位清空。21:57 又看到同一池出現新部位。這段期間 bot 沒有再廣播交易，所以新 LP 不是這次失敗流程存回去的。

### 鏈上唯讀核對

使用 README 記載的官方公開 RPC，只讀撤池收據與 ERC-6909 `balanceOf`：

- 鏈 ID 4663。撤池收據成功，撤池事件 1 筆，來源錢包相符。
- 舊部位份額是 0。
- 新部位份額大於 0，且和 22:35 的快照一致。
- 新區間 tick `-285300` 到 `-285060`。當時 tick `-285253`，在區間內。
- 日誌沒有 `pendingTx`。

因此檢查當時的資金在新 LP 裡，不是卡在一筆不明交易。復原鎖仍指著已經撤掉的舊部位，所以這個錢包的自動再平衡和自動停損都不會跑。停損判斷寫在 `executionPaused` 之後才會執行。

### 較早的停損紀錄

今天較早還有一次停損清倉失敗，原因是 `Execution is paused before swap approval`。台灣時間 14:08 的手動重跑已完成，其後也有成功的再平衡。`stopLiquidationStatus` 仍留著那次 `failed`。那是舊狀態，不是現在這筆鎖。

## 第二個錢包

`0x6F19…50bF` 沒有 active LP，目標顯示 CASHCAT/USDG，執行暫停，沒有復原鎖。這次 log 裡約 131 次 `wallet_pool.none_active`，是空倉監控，不是這次復原鎖的原因。實盤旗標是開啟的，但執行暫停，所以檢查當時沒有在送交易。

## 程式與介面問題

失敗當下的保護有生效：

- 授權在撤池前完成。
- 原子存入失敗就沒有廣播。
- 撤池後進入復原鎖。
- 暫停時不能直接按啟動。

有三個會誤導操作的點。這次沒有改原始碼：

1. `src/bot.js` 的失敗紀錄用 ethers 的 `error.message`。日誌其實已寫入 `LiquidityBelowMinimum` 的中文原因，事件列表卻顯示整段 `unknown custom error` 和 calldata。
2. `src/dashboard/page.js` 的預檢退避文案寫「不代表資產已移動」。這次撤池已經成功，那句話在失敗當下不成立。
3. 停損重跑完成後，舊的 `stopLiquidationStatus: failed` 還留著。

## 測試

- `npm run check`：通過。
- `npm test`：534 通過、0 失敗，約 11 秒。測試沒有送出主網交易。

## 建議

維持兩個錢包暫停。主錢包要先處理復原鎖，再考慮重新啟動。

若 21:57 出現的那個 PONS/USDG 部位就是要留下的倉，用中控台的「核對後續 LP 部位」。那個動作只核對撤池收據、後續 LP 收據和目前份額，核對通過才會清掉復原鎖，不會送新交易。清掉之後執行仍是暫停，要另外按啟動才會恢復自動再平衡和停損。

這次檢查沒有按那個核對鈕，也沒有跑 `resume-withdrawn-deposit.js --execute`。
