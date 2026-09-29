import { AbiCoder, keccak256 } from 'ethers';
import { ZERO_ADDRESS } from '../constants.js';

// Robinhood mainnet (4663). V3 addresses are pool contracts; V4 IDs are
// keccak256(PoolKey) and have no separate pair contract. Swap inputs must use
// these token addresses, never a ticker-only match.
export const MOO_TOKENS = Object.freeze({
  MOO: '0xD9dB30BB0D2b8d2eae3826A1372117E058791e18',
  USDG: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
  WETH: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73',
  ETH: ZERO_ADDRESS
});

export const MOO_V3_FACTORY = '0x1f7d7550b1b028f7571e69a784071f0205fd2efa';
export const MOO_V3_QUOTER = '0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7';
export const MOO_V4_STATE_VIEW = '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b';

export const MOO_V3_POOLS = Object.freeze([
  { pair: 'MOO/WETH', fee: 3000, address: '0x4aF88fce3336B55C06ceb32DeFcE7B8d1d430f8C' },
  { pair: 'MOO/WETH', fee: 10000, address: '0x9036A9406DAC1c252C364D037f489E5F0A752F54' },
  { pair: 'MOO/USDG', fee: 100, address: '0xBAC8c1487fc07e913f3588624246416B1688e2a3' },
  { pair: 'MOO/USDG', fee: 10000, address: '0x3F711D7a3330bcC9302b2849BDA88c477E904F43' },
  { pair: 'USDG/WETH', fee: 100, address: '0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca' },
  { pair: 'USDG/WETH', fee: 500, address: '0x69BfaF19C9f377BB306a89aEd9F6B07e2c1a8d9a' },
  { pair: 'USDG/WETH', fee: 3000, address: '0xa9188730Fe85Be88ad499D7d52B099e800fB0334' },
  { pair: 'USDG/WETH', fee: 10000, address: '0x5f009E071F07e92B6C624e83F52F17bBDa34680D' }
]);

export const MOO_V4_POOLS = Object.freeze([
  { pair: 'USDG/MOO', id: '0x6b187fad6ca2dcb913f2451c5d5e24d3d77b9d09ce272c2c99f64dac672bc485', fee: 8388608, tickSpacing: 200, hooks: '0x08E52564Bad99E05a694b4809F397edcA417A080', label: 'Fables dynamic' },
  { pair: 'USDG/MOO', id: '0x85a3cd053eecbcf2a67fd2c391479a2267e237edcea3acf19609b329e3a482fa', fee: 20000, tickSpacing: 200, hooks: ZERO_ADDRESS, label: 'Uniswap 2%' },
  { pair: 'USDG/MOO', id: '0x50b29d336ff8c80656c9c2e811a82779f8b8064b46c99799cf61d20d096765c8', fee: 39400, tickSpacing: 394, hooks: ZERO_ADDRESS, label: 'Uniswap 3.94%' },
  { pair: 'USDG/MOO', id: '0x3c38c0cb478ce74a8aba86f53267220f79ad050cbb49ea5851a428de39bc7bf0', fee: 50000, tickSpacing: 500, hooks: ZERO_ADDRESS, label: 'Uniswap 5%' },
  { pair: 'USDG/MOO', id: '0xd70cd268ac043ab2e4ec5dc1cdbd3cadf41dd466745025af3f687854f4d93075', fee: 80000, tickSpacing: 800, hooks: ZERO_ADDRESS, label: 'Uniswap 8%' },
  { pair: 'ETH/MOO', id: '0x6132955c48b86c50fa83d8fa8ba74ad557c2e68c51bf23f2e44ba7937570f995', fee: 10012, tickSpacing: 200, hooks: ZERO_ADDRESS, label: 'Uniswap 1.0012%' },
  { pair: 'ETH/MOO', id: '0x299cd9a098f3a7770a6c165b04a18a20f6949b0bfd4db3dfcb4682f66020f805', fee: 10002, tickSpacing: 200, hooks: ZERO_ADDRESS, label: 'Uniswap 1.0002%' },
  { pair: 'ETH/MOO', id: '0x2a06b51375754c76b2c95d1f07be0dc10d87de263a0d886bc0092eeed7c41166', fee: 10003, tickSpacing: 200, hooks: ZERO_ADDRESS, label: 'Uniswap 1.0003%' },
  { pair: 'ETH/MOO', id: '0xa63de67bc27279bee51d2b1269c95b691f327f9d0699e74bcb5c471cb7206020', fee: 10018, tickSpacing: 200, hooks: ZERO_ADDRESS, label: 'Uniswap 1.0018%' },
  { pair: 'ETH/MOO', id: '0xbdfac4c62d44726fe56513ef3708427a908e6e142f75d44a7161966fd633f078', fee: 10016, tickSpacing: 200, hooks: ZERO_ADDRESS, label: 'Uniswap 1.0016%' },
  { pair: 'ETH/MOO', id: '0x4c59cf318f0b0692dfbb5488342afb5bdd77201386fa0c5a9a8c0fcf8b5ae8f1', fee: 10015, tickSpacing: 200, hooks: ZERO_ADDRESS, label: 'Uniswap 1.0015%' },
  { pair: 'ETH/MOO', id: '0x5f202a8a27952912e584a8da1f7aa13a271b14cc4f1cdb58649b7c6b33dc568e', fee: 9900, tickSpacing: 99, hooks: ZERO_ADDRESS, label: 'Uniswap 0.99%' },
  { pair: 'ETH/MOO', id: '0x14fc21c0c33f88f6a08a4bfac790377bc40725b0e1c5476a251c6f456c94ae8c', fee: 30000, tickSpacing: 300, hooks: ZERO_ADDRESS, label: 'Uniswap 3%' },
  { pair: 'ETH/MOO', id: '0x2fc12e8ad83507232f36a908ef08e875753fdfde26f1fb7ec2693bfcd72bacc9', fee: 10017, tickSpacing: 200, hooks: ZERO_ADDRESS, label: 'Uniswap 1.0017%' },
  { pair: 'ETH/MOO', id: '0xf6a8a959422a373885f09afba6366d56b1a82de8db0daff6c88ba3fc5ea855c4', fee: 50000, tickSpacing: 500, hooks: ZERO_ADDRESS, label: 'Uniswap 5%' },
  { pair: 'ETH/MOO', id: '0x7bf3e49267ade1651d5299d1d6ac3bbad94120144989eb912776df5d49ece1a2', fee: 80000, tickSpacing: 800, hooks: ZERO_ADDRESS, label: 'Uniswap 8%' }
]);

const coder = AbiCoder.defaultAbiCoder();

export function mooV4PoolKey(entry) {
  const [left, right] = entry.pair.split('/');
  const key = {
    currency0: MOO_TOKENS[left], currency1: MOO_TOKENS[right],
    fee: entry.fee, tickSpacing: entry.tickSpacing, hooks: entry.hooks
  };
  if (!key.currency0 || !key.currency1) throw new Error(`Unknown MOO pool token: ${entry.pair}`);
  const id = keccak256(coder.encode(
    ['address', 'address', 'uint24', 'int24', 'address'],
    [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]
  ));
  if (id.toLowerCase() !== entry.id.toLowerCase()) throw new Error(`MOO V4 PoolId mismatch: ${entry.id}`);
  return key;
}
