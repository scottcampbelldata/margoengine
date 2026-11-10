// Classic worker for the prebuilt encoders, built as one self-contained script (scripts/build.js) so it can load the
// Emscripten wrappers with importScripts: no eval, so a strict CSP without 'unsafe-eval' covers it. Each Wasm module
// starts on its first job.
import { margoError } from '../../shared/errors.js';
import { encodeDracoMesh, type DracoEncoderModule, type DracoJob } from './draco-encode.js';
import { boxed, type EncoderRequest, type Factory, type ModuleBox } from './encoder-host.js';
import { encodeNativeMesh, loadNativeEncoder, type NativeDracoEncoder } from './draco-native-encode.js';
import { encodeBasis, type BasisEncoderModule, type BasisJob } from './ktx2-encode.js';
import { encodeNativeBasis, loadNativeBasis, type NativeBasis } from './basis-native.js';

declare const self: {
  onmessage: ((event: MessageEvent<EncoderRequest & { id: number }>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
  importScripts(...urls: string[]): void;
  DracoEncoderModule?: Factory<DracoEncoderModule>;
  BASIS?: Factory<BasisEncoderModule>;
};

async function bytes(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) throw margoError('failed', `Could not load ${url} (${response.status}); check the encoder folder`);
  return response.arrayBuffer();
}

let draco: Promise<ModuleBox<DracoEncoderModule>> | undefined;
let native: Promise<NativeDracoEncoder> | undefined;
const startDraco = async ({ wrapperURL, wasmURL }: EncoderRequest): Promise<ModuleBox<DracoEncoderModule>> => {
  self.importScripts(wrapperURL);
  if (!self.DracoEncoderModule)
    throw margoError(
      'failed',
      'Draco wrapper did not define DracoEncoderModule; load the unmodified draco_encoder_wrapper.js',
    );
  return boxed(self.DracoEncoderModule, await bytes(wasmURL));
};

let basis: Promise<ModuleBox<BasisEncoderModule>> | undefined;
let nativeBasis: Promise<NativeBasis> | undefined;
const startBasis = async ({ wrapperURL, wasmURL }: EncoderRequest): Promise<ModuleBox<BasisEncoderModule>> => {
  self.importScripts(wrapperURL);
  if (!self.BASIS)
    throw margoError('failed', 'Basis wrapper did not define BASIS; load basis_encoder.js from this package');
  return boxed(self.BASIS, await bytes(wasmURL), { print() {}, printErr() {} });
};

self.onmessage = async ({ data }) => {
  // Jobs come only from this package; anything that is not a job object is ignored.
  if (!data || typeof data !== 'object') return;
  const { id } = data;
  try {
    if (data.kind === 'draco-native') {
      native ??= loadNativeEncoder(data.wasmURL);
      const result = encodeNativeMesh(await native, data.job as DracoJob);
      self.postMessage({ id, result }, [result.data.buffer as ArrayBuffer]);
    } else if (data.kind === 'draco') {
      draco ??= startDraco(data);
      const { module } = await draco,
        result = encodeDracoMesh(module, data.job as DracoJob);
      self.postMessage({ id, result }, [result.data.buffer as ArrayBuffer]);
    } else if (data.kind === 'basis-native') {
      nativeBasis ??= loadNativeBasis(new URL(data.wasmURL));
      const result = encodeNativeBasis(await nativeBasis, data.job as BasisJob);
      self.postMessage({ id, result }, [result.data.buffer as ArrayBuffer]);
    } else if (data.kind === 'basis') {
      basis ??= startBasis(data);
      const { module } = await basis,
        result = encodeBasis(module, data.job as BasisJob);
      self.postMessage({ id, result }, [result.data.buffer as ArrayBuffer]);
    }
  } catch (error) {
    const { name, message, code } = error as Error & { code?: string };
    self.postMessage({ id, error: { name, message: message ?? String(error), code } });
  }
};
