// Worker script for @margoengine/gltf-pro/progressive (bundled to dist/workers/progressive.js): {url} starts the stream,
// {order} re-prioritizes it. Replies move their buffers and ImageBitmaps (no copies).
import { transferables } from '../../shared/worker.js';
import { GLTFStream } from './stream.js';
const scope = self as unknown as {
  onmessage: (event: { data: unknown }) => void;
  postMessage(message: unknown, transfer: Transferable[]): void;
};
let stream: GLTFStream | undefined;
// One {url} start, then {order} updates (integer primitive keys); anything else is ignored.
scope.onmessage = ({ data }) => {
  if (!data || typeof data !== 'object') return;
  const request = data as {
    order?: unknown;
    url?: unknown;
    maxDownloadBytes?: number;
    maxNodes?: number;
    allowedURLs?: readonly string[];
  };
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
    )).run();
};
