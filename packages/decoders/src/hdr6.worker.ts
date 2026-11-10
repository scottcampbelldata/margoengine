import { decodeHDR6, type HDR6Module } from './ktx2-hdr6-codec.js';
import { modulePort, wasmBytes } from './module-pool.js';

void modulePort().then((port) => {
  let loading: Promise<HDR6Module> | undefined;
  port.receive(async (data) => {
    try {
      loading ??= wasmBytes(data.wasmURL)
        .then((bytes) => WebAssembly.instantiate(bytes))
        .then(({ instance }) => instance.exports as unknown as HDR6Module);
      const module = await loading;
      const result = await decodeHDR6(module, new Uint8Array(data.buffer), data.target, { maxPixels: data.maxPixels });
      port.send(
        { id: data.id, result },
        result.mipmaps.map((mip) => mip.data.buffer as ArrayBuffer),
      );
    } catch (error) {
      if (error instanceof WebAssembly.RuntimeError) loading = undefined;
      port.send({ id: data.id, error: error instanceof Error ? error.message : String(error), code: 'failed' });
    }
  });
});
