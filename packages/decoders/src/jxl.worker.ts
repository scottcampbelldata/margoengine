// Module worker of JXLDecoder. It is an ES module, unlike decoder.worker.js, because the jxl-oxide glue is one, and it is
// named in `new Worker(new URL(...))` so bundlers follow its imports. The Wasm starts on the first job.
import init, { JxlImage } from './jxl/jxl_oxide_wasm.js';
import { renderJXL } from './jxl-render.js';

interface JXLJob {
  id: number;
  buffer: ArrayBuffer;
  wasmURL: string;
  maxPixels?: number;
}

declare const self: {
  onmessage: ((event: MessageEvent<JXLJob>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};

let ready: Promise<unknown> | undefined;

self.onmessage = async ({ data }) => {
  // Jobs come only from this package's pool; anything that is not a job object is ignored.
  if (!data || typeof data !== 'object') return;
  const { id } = data;
  try {
    ready ??= init({ module_or_path: data.wasmURL }).catch((error) => {
      ready = undefined;
      throw error;
    });
    await ready;
    const result = renderJXL({ JxlImage }, new Uint8Array(data.buffer), data.maxPixels);
    self.postMessage({ id, result }, [result.data.buffer as ArrayBuffer]);
  } catch (error) {
    self.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
    // After a Wasm trap the module's memory is undefined and the glue cannot start it again: an uncaught error makes the
    // pool replace this worker.
    if (error instanceof WebAssembly.RuntimeError)
      setTimeout(() => {
        throw error;
      });
  }
};
