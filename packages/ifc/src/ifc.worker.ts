// Worker script for @margoengine/ifc/worker (bundled to dist/workers/ifc.js): loads the caller's web-ifc build, then
// parseIFC. One worker per file, so a web-ifc that loops or traps on a malformed model is terminated, never reused.
import type { IfcAPI } from 'web-ifc';
import { serve } from '../../shared/worker.js';
import { parseIFC, type IFCOptions } from './index.js';
declare const self: { importScripts(...urls: string[]): void; WebIFC?: { IfcAPI: new () => IfcAPI } };
serve(
  async ({
    data,
    webIfc,
    wasmPath,
    options,
  }: {
    data: ArrayBuffer;
    webIfc: string;
    wasmPath?: string;
    options: IFCOptions;
  }) => {
    self.importScripts(webIfc);
    const api = new self.WebIFC!.IfcAPI();
    if (wasmPath) api.SetWasmPath(wasmPath, true);
    await api.Init();
    return parseIFC(api, new Uint8Array(data), options);
  },
);
