/** Match the adapter's explicit unsupported contract, retaining every other failure. */
export function smokeStatus(result) {
  const otherErrors = [...(result.errors ?? []), ...(result.pageErrors ?? [])];
  if (otherErrors.length) return 'error';
  if (result.unsupported || /^Error: unsupported:/.test(result.error ?? '')) return 'unsupported';
  return result.error ? 'error' : 'ok';
}
