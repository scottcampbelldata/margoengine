export function readResponse(
  response: Response,
  options: { maxBytes: number; signal?: AbortSignal; label?: string },
): Promise<Uint8Array<ArrayBuffer>>;
