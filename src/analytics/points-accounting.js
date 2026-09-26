import { formatUnits } from 'ethers';

const FEE_DENOMINATOR = 1_000_000n;

export function valueSwapFeeInUsd({ pool, swap, usdgAddress }) {
  const amount0 = BigInt(swap.amount0);
  const amount1 = BigInt(swap.amount1);
  const feePips = BigInt(swap.fee);
  if (feePips < 0n || feePips >= FEE_DENOMINATOR) {
    return unpriced('invalid-fee-pips', swap, feePips);
  }
  if (pool.token0?.decimals == null || pool.token1?.decimals == null) {
    return unpriced('missing-token-decimals', swap, feePips);
  }

  const inputIndex = amount0 > 0n ? 0 : amount1 > 0n ? 1 : -1;
  if (inputIndex < 0) return unpriced('missing-positive-input-delta', swap, feePips);

  const rawInput = inputIndex === 0 ? amount0 : amount1;
  const inputToken = inputIndex === 0 ? pool.token0 : pool.token1;
  const feeRaw = rawInput * feePips / FEE_DENOMINATOR;
  const inputAmount = Number(formatUnits(rawInput, inputToken.decimals));
  const feeAmount = Number(formatUnits(feeRaw, inputToken.decimals));
  const usdg = String(usdgAddress).toLowerCase();
  const token0IsUsdg = String(pool.token0.address).toLowerCase() === usdg;
  const token1IsUsdg = String(pool.token1.address).toLowerCase() === usdg;

  if ((inputIndex === 0 && token0IsUsdg) || (inputIndex === 1 && token1IsUsdg)) {
    return {
      priced: true,
      valuation: 'usdg-input',
      inputIndex,
      inputToken: inputToken.address,
      rawInput,
      inputAmount,
      feeRaw,
      feeAmount,
      feeUsd: Number(formatUnits(feeRaw, inputToken.decimals)),
      feePips: Number(feePips)
    };
  }

  if (!token0IsUsdg && !token1IsUsdg) {
    return {
      ...unpriced('pool-has-no-usdg-leg', swap, feePips),
      inputIndex,
      inputToken: inputToken.address,
      rawInput,
      inputAmount,
      feeRaw,
      feeAmount
    };
  }

  const usdgIndex = token0IsUsdg ? 0 : 1;
  const usdgDelta = usdgIndex === 0 ? amount0 : amount1;
  const usdgToken = usdgIndex === 0 ? pool.token0 : pool.token1;
  if (usdgDelta >= 0n) {
    return {
      ...unpriced('usdg-is-not-output-for-non-usdg-input', swap, feePips),
      inputIndex,
      inputToken: inputToken.address,
      rawInput,
      inputAmount,
      feeRaw,
      feeAmount
    };
  }

  // When the non-USDG token is the input, the negative USDG pool delta is the
  // realized output after the LP fee was removed from input. Valuing the fee at
  // the same realized execution rate gives:
  //   feeUsd = outputUsd * fee / (1 - fee)
  // This avoids using a later/current token price and keeps numerator/denominator
  // valuation tied to the exact on-chain swap.
  const outputUsd = Number(formatUnits(-usdgDelta, usdgToken.decimals));
  const feeRate = Number(feePips) / Number(FEE_DENOMINATOR);
  const feeUsd = feeRate > 0 && feeRate < 1
    ? outputUsd * feeRate / (1 - feeRate)
    : 0;

  return {
    priced: true,
    valuation: 'realized-usdg-output',
    inputIndex,
    inputToken: inputToken.address,
    rawInput,
    feeRaw,
    feeAmount,
    feeUsd,
    outputUsd,
    feePips: Number(feePips)
  };
}

function unpriced(reason, swap, feePips) {
  return {
    priced: false,
    reason,
    inputIndex: null,
    inputToken: null,
    rawInput: 0n,
    inputAmount: 0,
    feeRaw: 0n,
    feeAmount: 0,
    feeUsd: null,
    feePips: Number(feePips ?? swap?.fee ?? 0)
  };
}
