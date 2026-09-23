import { FallbackProvider, JsonRpcProvider } from 'ethers';

export function createProviders(config) {
  const network = { chainId: config.chainId, name: 'robinhood' };
  const rawProviders = config.rpcUrls.map((url) => new JsonRpcProvider(url, network, { staticNetwork: true }));
  const readProvider = rawProviders.length === 1
    ? rawProviders[0]
    : new FallbackProvider(
        rawProviders.map((provider, index) => ({
          provider,
          priority: index + 1,
          weight: 1,
          stallTimeout: 1200 + index * 400
        })),
        network,
        { quorum: 1 }
      );
  return { readProvider, writeProvider: rawProviders[0], rawProviders };
}

export async function verifyProviders(providers, chainId) {
  const results = [];
  for (let index = 0; index < providers.length; index += 1) {
    try {
      const network = await providers[index].getNetwork();
      results.push({ index, ok: Number(network.chainId) === chainId, chainId: Number(network.chainId) });
    } catch (error) {
      results.push({ index, ok: false, error: error.message });
    }
  }
  if (!results.some((x) => x.ok)) throw new Error('No configured RPC endpoint is healthy on Robinhood Chain');
  return results;
}
