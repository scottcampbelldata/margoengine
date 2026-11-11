// Worker-only bridge to the standard prebuilt OpenEXR decoder. No image codec implementation is copied here.
import { convertRGBA, exrChromaticities, exrToSRGB } from './exr-primaries.js';
declare const process: { versions?: { node?: string } };
interface Decoder {
  HEAPU8: Uint8Array;
  HEAP32: Int32Array;
  HEAPF32: Float32Array;
  UTF8ToString(pointer: number): string;
  _malloc(size: number): number;
  _free(pointer: number): void;
  _exrv_open(pointer: number, size: number): number;
  _exrv_close(file: number): void;
  _exrv_header_json(file: number): number;
  _exrv_last_error(): number;
  _exrv_decode_channels(file: number, part: number, indices: number, count: number, out: number): number;
}
declare function createExrViewModule(options: {
  instantiateWasm(imports: WebAssembly.Imports, receive: (instance: WebAssembly.Instance) => void): WebAssembly.Exports;
  printErr(message: string): void;
}): Promise<Decoder>;
interface Part {
  compression: string;
  storage: string;
  dataWindow: { min: [number, number]; max: [number, number] };
  displayWindow: { min: [number, number]; max: [number, number] };
  channels: { name: string }[];
}
interface Job {
  data: Uint8Array;
  part: number;
  maxPixels: number;
  layer?: string;
  wasm: string;
  module: string;
  commonjs: string;
}
const node = typeof process !== 'undefined' && !!process.versions?.node;
const nodeModule = <T>(name: string): Promise<T> => import(/* @vite-ignore */ name) as Promise<T>;

async function run(job: Job) {
  let factory: typeof createExrViewModule, wasm: Uint8Array;
  if (node) {
    const { readFile } = await nodeModule<{ readFile(url: URL): Promise<Uint8Array> }>('node:fs/promises');
    const { createRequire } = await nodeModule<{
      createRequire(url: string): (name: string) => typeof createExrViewModule;
    }>('node:module');
    factory = createRequire(job.commonjs)('./exrview.cjs');
    wasm = await readFile(new URL(job.wasm));
  } else {
    factory = (await nodeModule<{ default: typeof createExrViewModule }>(job.module)).default;
    const response = await fetch(job.wasm);
    if (!response.ok)
      throw new TypeError('EXR Wasm file could not be fetched; deploy the vendor directory beside the worker');
    wasm = new Uint8Array(await response.arrayBuffer());
  }
  if (
    wasm.byteLength < 8 ||
    new DataView(wasm.buffer, wasm.byteOffset, wasm.byteLength).getUint32(0, true) !== 0x6d736100
  )
    throw new TypeError(
      `EXR decoder Wasm is invalid (${wasm.byteLength} bytes); deploy the vendor Wasm file at ${job.wasm}`,
    );
  const compiled = new WebAssembly.Module(Uint8Array.from(wasm));
  const m = await factory({
    instantiateWasm(imports, receive) {
      const instance = new WebAssembly.Instance(compiled, imports);
      receive(instance);
      return instance.exports;
    },
    printErr() {},
  });
  const pointer = m._malloc(job.data.byteLength);
  if (!pointer) throw new RangeError('EXR input allocation failed; use a smaller file');
  m.HEAPU8.set(job.data, pointer);
  // The documented C ABI takes ownership of pointer on both success and failure.
  const file = m._exrv_open(pointer, job.data.byteLength);
  const failure = () => new TypeError(`EXR decode failed: ${m.UTF8ToString(m._exrv_last_error())}; check the file`);
  if (!file) throw failure();
  let indices = 0,
    output = 0;
  try {
    const header = JSON.parse(m.UTF8ToString(m._exrv_header_json(file))) as { parts: Part[] };
    const part = header.parts[job.part];
    if (!part) throw new RangeError('EXR part is absent; select an index from the file');
    const width = part.dataWindow.max[0] - part.dataWindow.min[0] + 1,
      height = part.dataWindow.max[1] - part.dataWindow.min[1] + 1;
    const pixels = width * height;
    if (!Number.isSafeInteger(pixels) || width < 1 || height < 1 || pixels > job.maxPixels)
      throw new RangeError('EXR data window exceeds maxPixels; raise the limit or use a smaller image');
    const names = part.channels.map((c) => c.name);
    const prefixes = ['', ...names.filter((n) => /\.(R|Y)$/.test(n)).map((n) => n.replace(/[^.]+$/, ''))];
    const complete = (prefix: string) =>
      names.includes(prefix + 'Y') || ['R', 'G', 'B'].every((c) => names.includes(prefix + c));
    const prefix = job.layer === undefined ? (prefixes.find(complete) ?? '') : job.layer ? job.layer + '.' : '';
    const color = ['R', 'G', 'B'].every((c) => names.includes(prefix + c))
      ? ['R', 'G', 'B']
      : names.includes(prefix + 'Y')
        ? ['Y']
        : [];
    if (!color.length) throw new TypeError('EXR color layer is absent; select a layer with R/G/B or Y channels');
    if (names.includes(prefix + 'A')) color.push('A');
    const channelNames = color.map((c) => prefix + c),
      count = color.length;
    if (pixels * count * 4 > 2147483647)
      throw new RangeError('EXR channel allocation exceeds Wasm memory; select a smaller image');
    indices = m._malloc(count * 4);
    output = m._malloc(pixels * count * 4);
    if (!indices || !output) throw new RangeError('EXR output allocation failed; use a smaller data window');
    channelNames.forEach((name, i) => {
      m.HEAP32[indices / 4 + i] = names.indexOf(name);
    });
    if (m._exrv_decode_channels(file, job.part, indices, count, output) !== 0) throw failure();
    const data = new Float32Array(pixels * 4),
      luminance = color[0] === 'Y',
      alpha = color.indexOf('A');
    for (let i = 0; i < pixels; i++) {
      for (let c = 0; c < 3; c++) data[i * 4 + c] = m.HEAPF32[output / 4 + (luminance ? 0 : c) * pixels + i];
      data[i * 4 + 3] = alpha < 0 ? 1 : m.HEAPF32[output / 4 + alpha * pixels + i];
    }
    // The prebuilt decoder's header JSON leaves `chromaticities` out: read it from the file's own header.
    const primaries = exrChromaticities(job.data, job.part),
      convert = luminance ? null : exrToSRGB(primaries);
    if (convert) convertRGBA(data, convert);
    return {
      width,
      height,
      data,
      compression: part.compression,
      storage: part.storage,
      dataWindow: part.dataWindow,
      displayWindow: part.displayWindow,
      channelNames,
      primaries,
      primariesConverted: !!convert,
    };
  } finally {
    if (indices) m._free(indices);
    if (output) m._free(output);
    m._exrv_close(file);
  }
}

async function boot() {
  const threads = node
    ? await nodeModule<{
        parentPort: {
          postMessage(value: unknown, transfer: ArrayBuffer[]): void;
          on(event: string, receive: (job: Job) => void): void;
        };
      }>('node:worker_threads')
    : undefined;
  const send = (value: unknown, transfer: ArrayBuffer[] = []) =>
    threads ? threads.parentPort!.postMessage(value, transfer) : globalThis.postMessage(value, { transfer });
  const receive = async (job: Job) => {
    try {
      const image = await run(job);
      send({ image }, [image.data.buffer]);
    } catch (error) {
      send({
        error: {
          kind: error instanceof RangeError ? 'range' : 'failed',
          message: error instanceof Error ? error.message : 'EXR decoder failed; check the file',
        },
      });
    }
  };
  if (threads) threads.parentPort!.on('message', receive);
  else
    globalThis.onmessage = (event) => {
      void receive(event.data);
    };
}
void boot();
export {};
