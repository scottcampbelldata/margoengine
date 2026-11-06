// Classic worker shared by DracoDecoder and KTX2Decoder, prebuilt as one self-contained script (scripts/build.js) so it
// can load the Emscripten wrappers with importScripts: no eval, so a strict CSP without 'unsafe-eval' covers it. Each
// Wasm module initializes on its first job.
import {
  decodeDraco,
  dracoTransferables,
  initBasis,
  initDraco,
  isDecoderCrash,
  transcodeKTX2,
  transcodeKTX2HDR,
  transcodeKTX2Layers,
  type ScriptLoader,
} from './codec.js';
import type { HDRTranscodeTarget } from './formats.js';
import type { TranscodeTarget, WorkerRequest } from './protocol.js';

declare const self: {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
  importScripts(...urls: string[]): void;
};
const load: ScriptLoader = async (url) => self.importScripts(url);
let draco: ReturnType<typeof initDraco> | undefined, basis: ReturnType<typeof initBasis> | undefined;

self.onmessage = async ({ data }) => {
  // Jobs come only from this package's pool; anything that is not a job object is ignored.
  if (!data || typeof data !== 'object') return;
  const { id } = data;
  try {
    if (data.type === 'draco') {
      draco ??= initDraco(data.wrapperURL, data.wasmURL, load).catch((error) => {
        draco = undefined;
        throw error;
      });
      const result = decodeDraco((await draco).module, new Uint8Array(data.buffer), data.request);
      self.postMessage({ id, result }, dracoTransferables(result));
    } else if (data.type === 'ktx2' || data.type === 'ktx2-layers' || data.type === 'ktx2-hdr') {
      basis ??= initBasis(data.transcoderURL, data.wasmURL, load).catch((error) => {
        basis = undefined;
        throw error;
      });
      const { module } = await basis,
        bytes = new Uint8Array(data.buffer),
        result =
          data.type === 'ktx2-hdr'
            ? transcodeKTX2HDR(module, bytes, data.target as HDRTranscodeTarget, data.exact)
            : data.type === 'ktx2'
              ? transcodeKTX2(module, bytes, data.target as TranscodeTarget)
              : transcodeKTX2Layers(module, bytes, data.target as TranscodeTarget, data.exact);
      self.postMessage({ id, result }, [result.mipmaps[0].data.buffer as ArrayBuffer]);
    } else throw new TypeError('Unknown decoder job; post a job made by the decoders package');
  } catch (error) {
    // After a Wasm trap the module's memory and stack are undefined: drop it so the next job instantiates a fresh one.
    if (isDecoderCrash(error)) {
      if (data.type === 'draco') draco = undefined;
      else basis = undefined;
    }
    self.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
};
