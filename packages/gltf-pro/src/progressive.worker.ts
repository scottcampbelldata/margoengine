// Worker script for @margoengine/gltf-pro/progressive (bundled to dist/workers/progressive.js): {url} starts the stream,
// {order} re-prioritizes it. Replies move their buffers and ImageBitmaps (no copies).
import {transferables} from '../../shared/worker.js';
import {GLTFStream} from './stream.js';
const scope = self as unknown as {onmessage: (event: {data: any}) => void; postMessage(message: unknown, transfer: Transferable[]): void};
let stream: GLTFStream | undefined;
scope.onmessage = ({data}) => {
  if (data.order) stream?.setOrder(data.order);
  else void (stream = new GLTFStream(new URL(data.url), message => scope.postMessage(message, [...transferables(message)]), new AbortController().signal, data.maxDownloadBytes)).run();
};
