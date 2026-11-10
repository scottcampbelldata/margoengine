import { AssetCache } from './index.js';

/**
 * AssetCache with pull-driven miss bodies. Bytes reach the caller before EOF; only complete bodies enter storage.
 * Inherits all AssetCache options. Consume or cancel each response before awaiting flush().
 */
export class StreamingAssetCache extends AssetCache {
  protected override async keep(
    request: Request,
    key: string,
    response: Response,
    range: string | null,
    sent: number,
  ): Promise<Response> {
    if (
      range ||
      response.status !== 200 ||
      !response.body ||
      /no-store/i.test(response.headers.get('cache-control') ?? '')
    )
      return super.keep(request, key, response, range, sent);
    const reader = response.body.getReader();
    let parts: Uint8Array<ArrayBuffer>[] = [],
      size = 0,
      cacheable = true,
      settled = false;
    let abort = () => {};
    let finish!: () => void;
    this.track(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    const release = () => {
      if (settled) return;
      settled = true;
      request.signal.removeEventListener('abort', abort);
      parts = [];
      reader.releaseLock();
      finish();
    };
    const body = new ReadableStream<Uint8Array>(
      {
        start: (controller) => {
          abort = () => {
            cacheable = false;
            controller.error(request.signal.reason);
            void reader.cancel(request.signal.reason).then(release, release);
          };
          request.signal.addEventListener('abort', abort, { once: true });
          if (request.signal.aborted) abort();
        },
        pull: async (controller) => {
          try {
            request.signal.throwIfAborted();
            const { value, done } = await reader.read();
            if (settled || (!cacheable && request.signal.aborted)) return;
            if (done) {
              if (cacheable) {
                const stored = new Response(new Blob(parts), {
                  status: response.status,
                  statusText: response.statusText,
                  headers: response.headers,
                });
                Object.defineProperty(stored, 'url', { value: response.url });
                // Storage failure must not turn a successful network response into an error.
                await super.keep(request, key, stored, null, sent).catch(() => {
                  this.stats.errors++;
                });
              }
              release();
              controller.close();
            } else {
              size += value.byteLength;
              if (size > this.maxBytes) {
                cacheable = false;
                parts = [];
              }
              if (cacheable) parts.push(value.slice());
              controller.enqueue(value);
            }
          } catch (error) {
            if (settled) return;
            release();
            controller.error(error);
          }
        },
        cancel: async (reason) => {
          cacheable = false;
          try {
            await reader.cancel(reason);
          } finally {
            release();
          }
        },
      },
      { highWaterMark: 0 },
    );
    const result = new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
    for (const name of ['url', 'redirected', 'type'] as const)
      Object.defineProperty(result, name, { value: response[name] });
    return result;
  }
}
