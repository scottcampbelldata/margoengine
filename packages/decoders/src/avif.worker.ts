import { decodeAVIFModule, type AVIFModule } from './avif-codec.js';
import { modulePort, wasmBytes } from './module-pool.js';

void modulePort().then((port) => {
  let loading: Promise<AVIFModule> | undefined;
  port.receive(async (data) => {
    try {
      loading ??= wasmBytes(data.wasmURL)
        .then((bytes) => WebAssembly.instantiate(bytes))
        .then(({ instance }) => instance.exports as unknown as AVIFModule);
      const module = await loading;
      const result = decodeAVIFModule(module, new Uint8Array(data.buffer), data.format, data.maxPixels, data.maxMemory);
      port.send({ id: data.id, result }, [result.data.buffer as ArrayBuffer, result.color.icc.buffer as ArrayBuffer]);
    } catch (error) {
      // A trapped Wasm instance may have an interrupted allocator. Its worker never reuses that instance.
      if (error instanceof WebAssembly.RuntimeError) loading = undefined;
      port.send({
        id: data.id,
        error: error instanceof Error ? error.message : String(error),
        code: (error as { code?: string })?.code ?? 'failed',
      });
    }
  });
});
