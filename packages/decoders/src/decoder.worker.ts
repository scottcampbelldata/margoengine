// Module worker shared by DracoDecoder and KTX2Decoder. Each Wasm module initializes on its first job.
import {decodeDraco, dracoTransferables, initBasis, initDraco, transcodeKTX2, type ModuleBox} from './codec.js';
import type {WorkerRequest} from './protocol.js';

declare const self: {onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null; postMessage(message: unknown, transfer?: Transferable[]): void};
let draco: Promise<ModuleBox> | undefined, basis: Promise<ModuleBox> | undefined;

self.onmessage = async ({data}) => {
  const {id} = data;
  try {
    if (data.type === 'draco') {
      draco ??= initDraco(data.wrapperURL, data.wasmURL).catch(error => {draco = undefined; throw error;});
      const result = decodeDraco((await draco).module, new Uint8Array(data.buffer), data.request);
      self.postMessage({id, result}, dracoTransferables(result));
    } else if (data.type === 'ktx2') {
      basis ??= initBasis(data.transcoderURL, data.wasmURL).catch(error => {basis = undefined; throw error;});
      const result = transcodeKTX2((await basis).module, new Uint8Array(data.buffer), data.target);
      self.postMessage({id, result}, [result.mipmaps[0].data.buffer as ArrayBuffer]);
    } else throw new TypeError('Unknown decoder job');
  } catch (error) {
    self.postMessage({id, error: error instanceof Error ? error.message : String(error)});
  }
};
