// Worker script for @margoengine/gltf/progressive (bundled to dist/workers/progressive.js): {url} starts the stream,
// {order} re-prioritizes it. Replies move their buffers and ImageBitmaps (no copies).
import { transferables } from '../../shared/worker.js';
import { GLTFStream } from './stream.js';
import type { GLTFDracoDecodeOptions, GLTFDracoGeometry } from './asset.js';
const scope = self as unknown as {
  onmessage: (event: { data: unknown }) => void;
  postMessage(message: unknown, transfer: Transferable[]): void;
};
let stream: GLTFStream | undefined;
// Draco streams out at the main thread's decoder, by request id.
const waiting = new Map<number, { resolve(result: GLTFDracoGeometry): void; reject(error: Error): void }>();
let requests = 0;
const draco = {
  decode(data: Uint8Array, { signal: _, ...options }: GLTFDracoDecodeOptions): Promise<GLTFDracoGeometry> {
    const id = ++requests,
      copy = data.slice();
    return new Promise((resolve, reject) => {
      waiting.set(id, { resolve, reject });
      scope.postMessage({ type: 'draco', id, data: copy, options }, [copy.buffer]);
    });
  },
};
// One {url} start, then {order} updates (integer primitive keys) and {draco} answers; anything else is ignored.
scope.onmessage = ({ data }) => {
  if (!data || typeof data !== 'object') return;
  const request = data as {
    order?: unknown;
    url?: unknown;
    maxDownloadBytes?: number;
    maxNodes?: number;
    allowedURLs?: readonly string[];
    textures?: boolean;
    maxPartVertices?: number;
    draco?: number;
    result?: GLTFDracoGeometry;
    error?: { name?: string; message?: string; code?: string };
  };
  if (typeof request.draco === 'number') {
    const answer = waiting.get(request.draco),
      e = request.error;
    waiting.delete(request.draco);
    if (e) answer?.reject(Object.assign(new Error(e.message), { name: e.name, code: e.code }));
    else answer?.resolve(request.result!);
    return;
  }
  if (Array.isArray(request.order)) {
    if (request.order.every(Number.isSafeInteger)) stream?.setOrder(request.order);
  } else if (!stream && typeof request.url === 'string')
    void (stream = new GLTFStream(
      new URL(request.url),
      (message) => scope.postMessage(message, [...transferables(message)]),
      new AbortController().signal,
      request.maxDownloadBytes,
      request.maxNodes,
      request.allowedURLs,
      request.textures === true,
      request.maxPartVertices,
      { draco },
    )).run();
};
