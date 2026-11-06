// Classic worker for the prebuilt encoders, built as one self-contained script (scripts/build.js) so it can load the
// Emscripten wrappers with importScripts: no eval, so a strict CSP without 'unsafe-eval' covers it. Each Wasm module
// starts on its first job.
import { margoError } from '../../shared/errors.js';
import { encodeDracoMesh, type DracoEncoderModule, type DracoJob } from './draco-encode.js';
import { boxed, type EncoderRequest, type ModuleBox } from './encoder-host.js';

declare const self: {
  onmessage: ((event: MessageEvent<EncoderRequest & { id: number }>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
  importScripts(...urls: string[]): void;
  DracoEncoderModule?: (options: { wasmBinary: ArrayBuffer }) => PromiseLike<DracoEncoderModule>;
};

async function bytes(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) throw margoError('failed', `Could not load ${url} (${response.status}); check the encoder folder`);
  return response.arrayBuffer();
}

let draco: Promise<ModuleBox<DracoEncoderModule>> | undefined;
const startDraco = async ({ wrapperURL, wasmURL }: EncoderRequest): Promise<ModuleBox<DracoEncoderModule>> => {
  self.importScripts(wrapperURL);
  if (!self.DracoEncoderModule)
    throw margoError(
      'failed',
      'Draco wrapper did not define DracoEncoderModule; load the unmodified draco_encoder_wrapper.js',
    );
  return boxed(self.DracoEncoderModule, await bytes(wasmURL));
};

self.onmessage = async ({ data }) => {
  // Jobs come only from this package; anything that is not a job object is ignored.
  if (!data || typeof data !== 'object') return;
  const { id } = data;
  try {
    if (data.kind === 'draco') {
      draco ??= startDraco(data);
      const { module } = await draco,
        result = encodeDracoMesh(module, data.job as DracoJob);
      self.postMessage({ id, result }, [result.data.buffer as ArrayBuffer]);
    }
  } catch (error) {
    self.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
};
