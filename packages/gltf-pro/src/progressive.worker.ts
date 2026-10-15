// Worker script for @margoengine/gltf-pro/progressive (bundled to dist/workers/progressive.js): {url} starts the stream,
// {order} re-prioritizes it. Replies move their buffers and ImageBitmaps (no copies).
import { transferables } from '../../shared/worker.js';
import { GLTFStream } from './stream.js';
const scope = self as unknown as {
  onmessage: (event: { data: any }) => void;
  postMessage(message: unknown, transfer: Transferable[]): void;
};
let stream: GLTFStream | undefined;
// One {url} start, then {order} updates (integer primitive keys); anything else is ignored.
scope.onmessage = ({ data }) => {
  if (!data || typeof data !== 'object') return;
  if (Array.isArray(data.order)) {
    if (data.order.every(Number.isSafeInteger)) stream?.setOrder(data.order);
  } else if (!stream && typeof data.url === 'string')
    void (stream = new GLTFStream(
      new URL(data.url),
      (message) => scope.postMessage(message, [...transferables(message)]),
      new AbortController().signal,
      data.maxDownloadBytes,
      data.maxNodes,
      data.allowedURLs,
    )).run();
};
