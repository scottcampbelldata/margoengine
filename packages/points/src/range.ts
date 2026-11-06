import { MargoError } from '@margoengine/math/errors';

async function answer(
  fetcher: typeof fetch,
  url: string | URL,
  init: RequestInit,
): Promise<{ body: Uint8Array; status: number }> {
  init.signal?.throwIfAborted();
  const response = await fetcher(url, init);
  if (!response.ok)
    throw new MargoError(
      'failed',
      `GET ${url} answered ${response.status}; check the URL and that the server allows it`,
    );
  return { body: new Uint8Array(await response.arrayBuffer()), status: response.status };
}

/** `bytes` bytes from `at`: the answered part, or the part cut out of a whole file when the server ignored `Range`. */
export async function readRange(
  fetcher: typeof fetch,
  url: string | URL,
  at: number,
  bytes: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const { body, status } = await answer(fetcher, url, {
    signal,
    headers: { Range: `bytes=${at}-${at + bytes - 1}` },
  });
  return status === 206 ? body : body.subarray(at, at + bytes);
}

/** A whole file. */
export async function readWhole(fetcher: typeof fetch, url: string | URL, signal?: AbortSignal): Promise<Uint8Array> {
  return (await answer(fetcher, url, { signal })).body;
}
