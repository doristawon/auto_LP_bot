// eth_simulateV1 executes these calls against one temporary state. It never
// broadcasts them, but the provider must support the method and report every
// receipt successful before a multi-step live top-up can begin.
export async function simulateSequentialCalls(provider, { walletAddress, chainId, calls }) {
  if (!Array.isArray(calls) || calls.length < 1 || calls.length > 32) {
    throw new Error('Sequential simulation requires 1..32 calls');
  }
  const actualChainId = BigInt(await provider.send('eth_chainId', []));
  if (actualChainId !== BigInt(chainId)) throw new Error('Sequential simulation RPC chainId mismatch');
  const encodedCalls = calls.map((call) => {
    if (!call?.to || !call?.data || !Number.isSafeInteger(call.gasLimit) || call.gasLimit < 21_000) {
      throw new Error('Sequential simulation call is incomplete');
    }
    return {
      from: walletAddress,
      to: call.to,
      data: call.data,
      value: `0x${BigInt(call.value || 0n).toString(16)}`,
      gas: `0x${BigInt(call.gasLimit).toString(16)}`
    };
  });
  const blocks = await provider.send('eth_simulateV1', [
    { blockStateCalls: [{ calls: encodedCalls }], validation: false },
    'latest'
  ]);
  const results = blocks?.[0]?.calls;
  if (!Array.isArray(results) || results.length !== calls.length) {
    throw new Error('Sequential simulation returned an incomplete call list');
  }
  for (let index = 0; index < results.length; index++) {
    if (results[index]?.status !== '0x1') {
      const revertData = [results[index]?.returnData, results[index]?.error?.data]
        .find(value => typeof value === 'string' && /^0x[0-9a-fA-F]{8}/.test(value)) || '';
      const selector = /^0x[0-9a-fA-F]{8}/.test(revertData) ? ` (${revertData.slice(0, 10)})` : '';
      const error = new Error(`Sequential simulation call ${index + 1} failed: ${results[index]?.error?.message || 'reverted'}${selector}`);
      error.simulationResults = results;
      error.revertSelector = revertData.slice(0, 10) || null;
      if (results[index]?.error?.code === 3) error.code = 'SEQUENTIAL_SIMULATION_REVERT';
      throw error;
    }
  }
  return results;
}
