/** The code of a thrown value: a `MargoError` code, else `argument` (TypeError), `range` (RangeError) or `failed`. */
export function errorCode(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    return error.name === 'RangeError' ? 'range' : error.name === 'TypeError' ? 'argument' : 'failed';
  }
  return 'failed';
}

/** The help page entry a message links to, if any (`; see https://margoengine.com/errors#mcp`). */
export function helpLink(error: unknown): string | undefined {
  return error instanceof Error ? /https:\/\/margoengine\.com\/errors#[\w-]+/.exec(error.message)?.[0] : undefined;
}
