import test from 'node:test';
import assert from 'node:assert/strict';
import { id } from 'ethers';
import { FablesAdapter } from '../src/adapters/fables.js';

const SIGNATURE = 'withdrawAndClaim((address,address,uint24,int24,address),int24,int24,uint128,address,uint128,uint128,uint256,uint16)';
const REAL_DATA = '0x289a2a15'
  + '00000000000000000000000056910d4409f3a0c78c64dd8d0545ff0705389870'
  + '0000000000000000000000005fc5360d0400a0fd4f2af552add042d716f1d168'
  + '0000000000000000000000000000000000000000000000000000000000800000'
  + '0000000000000000000000000000000000000000000000000000000000000078'
  + '00000000000000000000000008e52564bad99e05a694b4809f397edca417a080'
  + 'fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffb4448'
  + 'fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffb4538'
  + '0000000000000000000000000000000000000000000000000b846c0dddc70f1e'
  + '0000000000000000000000006f196af3b69c521eed9436abc9130699df1c50bf'
  + '000000000000000000000000000000000000000000000b6704c559cc475aee3f'
  + '0000000000000000000000000000000000000000000000000000000000000000'
  + '000000000000000000000000000000000000000000000000000000006ab2c316'
  + '00000000000000000000000000000000000000000000000000000000000003e8';

test('verified Fables withdrawAndClaim signature matches real selector', () => {
  assert.equal(id(SIGNATURE).slice(0, 10), '0x289a2a15');
});

test('encoder reproduces a real successful Fables withdraw transaction byte-for-byte', () => {
  const adapter = Object.create(FablesAdapter.prototype);
  adapter.config = { walletAddress: '0x6F196aF3B69c521eEd9436Abc9130699dF1c50bF' };
  const pool = {
    key: {
      currency0: '0x56910D4409F3a0C78C64DD8D0545FF0705389870',
      currency1: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
      fee: 0x800000,
      tickSpacing: 120,
      hooks: '0x08E52564Bad99E05a694b4809F397edcA417A080'
    }
  };
  const position = {
    tickLower: -310200,
    tickUpper: -309960,
    shares: 829907038154198814n
  };
  const encoded = adapter.encodeWithdrawAndClaim(
    pool,
    position,
    53846389730838650220095n,
    0n,
    1790100246,
    1000
  );
  assert.equal(encoded.toLowerCase(), REAL_DATA.toLowerCase());
});
