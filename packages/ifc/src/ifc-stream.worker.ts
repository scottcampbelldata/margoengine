// Worker script for @margoengine/ifc/worker streamIFCInWorker (bundled to dist/workers/ifc-stream.js): loads the
// caller's web-ifc build, opens the model and posts each meshChunks chunk as it is read, then `done`. One worker per
// file, terminated by the caller when it stops reading, aborts or hears nothing for its time limit.
import type { IfcAPI } from 'web-ifc';
import { transferables } from '../../shared/worker.js';
import { meshChunks, type IFCStreamOptions } from './meshes.js';
import { openIFC, type IFCOpenOptions } from './open.js';
declare const self: {
  importScripts(...urls: string[]): void;
  WebIFC?: { IfcAPI: new () => IfcAPI };
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((event: { data: unknown }) => void) | null;
};
self.onmessage = async ({ data }) => {
  try {
    if (!data || typeof data !== 'object') throw new TypeError('Invalid IFC stream job; post an object');
    const { buffer, webIfc, wasmPath, options } = data as {
      buffer: ArrayBuffer;
      webIfc: string;
      wasmPath?: string;
      options: IFCStreamOptions & IFCOpenOptions;
    };
    self.importScripts(webIfc);
    const api = new self.WebIFC!.IfcAPI();
    if (wasmPath) api.SetWasmPath(wasmPath, true);
    await api.Init();
    const model = openIFC(api, new Uint8Array(buffer), options);
    try {
      for (const chunk of meshChunks(model, options)) self.postMessage({ chunk }, [...transferables(chunk)] as Transferable[]);
    } finally {
      model.close();
    }
    self.postMessage({ done: true });
  } catch (error) {
    const reply = { name: (error as Error)?.name ?? 'Error', message: error instanceof Error ? error.message : String(error) };
    try {
      self.postMessage({ error: { ...(error as object), ...reply } });
    } catch {
      self.postMessage({ error: reply });
    }
  }
};
