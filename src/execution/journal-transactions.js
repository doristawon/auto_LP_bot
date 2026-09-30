export function journalTransactions(journal) {
  const result = [];
  for (const [phase, value] of Object.entries(journal?.tx || {})) {
    const hashes = Array.isArray(value) ? value : [value];
    for (const [index, hash] of hashes.entries()) {
      if (!hash) continue;
      if (typeof hash !== 'string' || !/^0x[0-9a-f]{64}$/i.test(hash)) {
        throw new Error('Execution journal contains an invalid transaction hash');
      }
      result.push({ phase: Array.isArray(value) ? `${phase}:${index}` : phase, hash });
    }
  }
  if (journal?.pendingTx?.hash && !result.some(item => item.hash === journal.pendingTx.hash)) {
    result.push(...journalTransactions({ tx: { pending: journal.pendingTx.hash } }));
  }
  return result;
}
