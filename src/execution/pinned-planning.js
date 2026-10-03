import { pinnedSimulationProvider } from './pinned-simulation.js';

// Isolate one planning round from the live signer and adapters. All quotes,
// approval reads and previews use the same explicit chain state.
export async function createPinnedPlanningContext(executor) {
  const blockTag = await executor.writeProvider.send('eth_blockNumber', []);
  const readProvider = pinnedSimulationProvider(executor.readProvider, blockTag);
  const writeProvider = pinnedSimulationProvider(executor.writeProvider, blockTag);
  const copy = (adapter, provider) => Object.assign(Object.create(adapter), { provider });
  const context = Object.assign(Object.create(executor), { readProvider, writeProvider,
    fables: copy(executor.fables, readProvider), quoter: copy(executor.quoter, readProvider),
    router: copy(executor.router, readProvider), signer: null, planningBlockTag: blockTag });
  context.quoter.v3PendingPools = new Map();
  context.sendVerifiedTx = context.ensureSwapAllowances = context.runWalletWrite = () => {
    throw new Error('Pinned planning context cannot submit transactions');
  };
  return context;
}
