// Compare independent candidate simulations against the same chain state.
// This proxy is read-only and must never be connected to a broadcast signer.
export function pinnedSimulationProvider(provider, blockTag) {
  if (!/^0x[0-9a-f]+$/i.test(blockTag || '')) throw new Error('Pinned simulation requires an explicit block number');
  const blockNumber = Number(BigInt(blockTag));
  if (!Number.isSafeInteger(blockNumber)) throw new Error('Pinned simulation block is invalid');
  return new Proxy(provider, {
    get(target, property) {
      if (property === 'send') return async (method, parameters) => {
        if (['eth_sendRawTransaction', 'eth_sendTransaction'].includes(method)) {
          throw new Error('Pinned simulation provider cannot broadcast');
        }
        if (method === 'eth_simulateV1') return target.send(method, [parameters[0], blockTag]);
        if (method === 'eth_call') return target.send(method, [parameters[0], blockTag, ...parameters.slice(2)]);
        return target.send(method, parameters);
      };
      if (property === 'broadcastTransaction') return async () => { throw new Error('Pinned simulation provider cannot broadcast'); };
      if (property === 'call') return request => target.send('eth_call', [target.getRpcTransaction(request), blockTag]);
      if (property === 'getCode') return address => target.getCode(address, blockTag);
      if (property === 'getBlockNumber') return async () => blockNumber;
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
}
