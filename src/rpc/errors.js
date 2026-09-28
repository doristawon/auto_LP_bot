export function isRpcRateLimitError(error) {
  const parts = [error?.message, error?.shortMessage, error?.cause?.message,
    error?.info?.error?.message, error?.info?.responseText];
  const message = parts.filter(Boolean).join(' ');
  return /\b429\b|rate[ -]?limit|request limit|too many requests|quota|credits? exhausted|resource exhausted|compute units|\b-32005\b/i.test(message);
}

export function isRpcTimeoutError(error) {
  const message = [error?.message, error?.shortMessage, error?.cause?.message].filter(Boolean).join(' ');
  return error?.code === 'TIMEOUT' || /\btimed? ?out\b|\bETIMEDOUT\b/i.test(message);
}
