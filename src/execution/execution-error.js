import { Interface } from 'ethers';
import { EIP7702_GUARD_ABI } from '../abi.js';
import { sanitize } from '../logger.js';

const guard = new Interface(EIP7702_GUARD_ABI);
const KNOWN_GUARD_ERRORS = Object.freeze({
  LiquidityBelowMinimum: '價格變動使可存入流動性低於最低限制；原子存入未完成。',
  ExcessResidual: '原子存入後殘餘代幣超出允許上限；原子存入未完成。'
});
const KNOWN_BY_SELECTOR = new Map(Object.keys(KNOWN_GUARD_ERRORS).map(name => [
  guard.getError(name).selector.toLowerCase(), name
]));

const isHexData = value => typeof value === 'string' && /^0x(?:[\da-f]{2})+$/i.test(value);
const isSelector = value => typeof value === 'string' && /^0x[\da-f]{8}$/i.test(value);

function findHexData(value, depth = 0, seen = new Set()) {
  if (isHexData(value)) return value;
  if (!value || typeof value !== 'object' || depth >= 5 || seen.has(value)) return null;
  seen.add(value);
  for (const key of ['data', 'result', 'returnData', 'error', 'cause', 'info', 'originalError']) {
    if (Object.hasOwn(value, key)) {
      const found = findHexData(value[key], depth + 1, seen);
      if (found) return found;
    }
  }
  // Some JSON-RPC clients nest revert data under a transaction-hash key.
  if (depth < 2) {
    for (const nested of Object.values(value)) {
      const found = findHexData(nested, depth + 1, seen);
      if (found) return found;
    }
  }
  return null;
}

function knownGuardError(errorData, selector) {
  let decodedName = null;
  try { decodedName = errorData ? guard.parseError(errorData)?.name || null : null; } catch {}
  if (Object.hasOwn(KNOWN_GUARD_ERRORS, decodedName)) {
    return { name: decodedName, selector: guard.getError(decodedName).selector };
  }
  const bySelector = selector && KNOWN_BY_SELECTOR.get(selector.toLowerCase());
  return bySelector ? { name: bySelector, selector: guard.getError(bySelector).selector } : null;
}

function summaryFor(name, selector) {
  return { error: KNOWN_GUARD_ERRORS[name], errorSelector: selector, guardError: name };
}

function namedGuardError(error) {
  const explicitNames = [error?.errorName, error?.revert?.name, error?.revertName,
    error?.errorFragment?.name];
  for (const name of explicitNames) {
    if (Object.hasOwn(KNOWN_GUARD_ERRORS, name)) return name;
  }
  for (const text of [error?.shortMessage, error?.message]) {
    if (typeof text !== 'string') continue;
    const match = text.match(/\b(LiquidityBelowMinimum|ExcessResidual)\s*(?:\([^)]*\))?/);
    if (match) return match[1];
  }
  return null;
}

function journalGuardError(nameValue, selectorValue) {
  const name = Object.hasOwn(KNOWN_GUARD_ERRORS, nameValue) ? nameValue : null;
  const selector = isSelector(selectorValue) ? selectorValue : null;
  const bySelector = selector && KNOWN_BY_SELECTOR.get(selector.toLowerCase());
  if (name && bySelector && bySelector !== name) return null;
  if (selector && !bySelector) return null;
  const resolved = name || bySelector;
  if (!resolved) return null;
  return { name: resolved, selector: guard.getError(resolved).selector };
}

function matchingJournalFallback(error, fallbackJournal) {
  const executionId = error?.executionJournalId;
  if (!executionId || !fallbackJournal?.id || executionId !== fallbackJournal.id) return null;
  const message = String(error?.shortMessage || error?.message || '');
  if (!/unknown custom error|Atomic planning exceeded five minutes/i.test(message)) return null;
  if (fallbackJournal.guardError || fallbackJournal.errorSelector) {
    return journalGuardError(fallbackJournal.guardError, fallbackJournal.errorSelector);
  }
  return journalGuardError(fallbackJournal.atomicRetryGuardError, fallbackJournal.atomicRetrySelector);
}

function safeMessage(error) {
  const original = error?.shortMessage || error?.message || String(error || '執行失敗');
  // Error text can include the complete calldata even when the structured
  // `data` property is absent. Keep the reason text, but remove every hex blob.
  return sanitize(String(original))
    .replace(/0x[\da-f]{8,}/gi, '[錯誤資料已省略]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 360) || '執行失敗；詳細錯誤資料已省略。';
}

/**
 * Produce an event-safe execution error. Known guard errors get stable
 * Traditional Chinese summaries; custom-error arguments and calldata are
 * never copied into the returned message.
 *
 * A prior retry summary may be used only when the thrown error carries the
 * exact journal ID being supplied by the caller.
 */
export function summarizeExecutionError(error, { fallbackJournal = null } = {}) {
  const errorData = findHexData(error?.data)
    || findHexData(error?.info?.error?.data)
    || findHexData(error?.error?.data)
    || findHexData(error?.cause?.data);
  const dataSelector = isHexData(errorData) ? errorData.slice(0, 10).toLowerCase() : null;
  const explicitSelector = isSelector(error?.revertSelector) ? error.revertSelector.toLowerCase()
    : isSelector(error?.errorSelector) ? error.errorSelector.toLowerCase() : null;
  const selector = explicitSelector || dataSelector;
  const direct = knownGuardError(errorData, selector);
  if (direct) return summaryFor(direct.name, direct.selector);

  // If this error contains its own revert payload, do not let an older retry
  // replace it with a different explanation. Keep only its 4-byte selector.
  if (errorData || selector) {
    return { error: selector
      ? `合約回報未分類錯誤（${selector}）；錯誤資料已省略。`
      : '合約回報未分類錯誤；錯誤資料已省略。',
    errorSelector: selector, guardError: null };
  }

  const named = namedGuardError(error);
  if (named) return summaryFor(named, guard.getError(named).selector);

  const fallback = matchingJournalFallback(error, fallbackJournal);
  if (fallback) return summaryFor(fallback.name, fallback.selector);
  return { error: safeMessage(error), errorSelector: null, guardError: null };
}
