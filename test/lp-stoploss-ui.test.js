import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { dashboardPage } from '../src/dashboard/page.js';

test('dashboard exposes LP-session and legacy stop-loss basis modes with clear LP-session rules', () => {
  const html = dashboardPage();

  assert.ok(html.includes('id="stopLossBasisMode" aria-describedby="stopLossBasisHelp"'));
  assert.ok(html.includes('<option value="lp-session">LP 投入後起算（再平衡不重設）</option>'));
  assert.ok(html.includes('<option value="armed-equity">啟用當下估值（舊模式）</option>'));
  assert.ok(html.includes('LP 投入後起算；再平衡不重設基準；資產含 LP＋錢包，交易成本與 Gas 計入；待 LP 投入時不開始計算。'));
  assert.ok(html.includes('if(risk.settings?.basisMode===\'lp-session\'||risk.settings?.basisMode===\'armed-equity\')return risk.settings.basisMode;return risk.settings?\'armed-equity\':\'lp-session\''));
});

test('dashboard stop-loss script saves the selected mode and reports pending LP confirmation', () => {
  const html = dashboardPage();
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];

  assert.ok(script, 'dashboard inline script exists');
  new vm.Script(script);
  assert.ok(script.includes("$('stopLossBasisMode').value=stopLossModeFromSettings(risk)"));
  assert.ok(script.includes("risk.status==='waiting-lp'?'等待 LP 投入確認'"));
  assert.ok(script.includes("(risk.reason?' · '+safeEventText(risk.reason,180):'')"));
  assert.ok(script.includes('lossPct:Number($(\'stopLossPct\').value),basisMode,rebase'));
  assert.ok(script.includes('後續再平衡不會自動重設基準'));
});
