import { decodeJPEG2000Module, type JPEG2000Module } from './jpeg2000-codec.js';
import { modulePort, wasmBytes } from './module-pool.js';

void modulePort().then((port) => {
  let loading: Promise<WebAssembly.Module> | undefined;
  port.receive(async (data) => {
    try {
      loading ??= wasmBytes(data.wasmURL).then((bytes) => WebAssembly.compile(bytes));
      const compiled = await loading.catch((error: unknown) => {
        loading = undefined;
        throw error;
      });
      // One instance per image: Wasm memory only grows, so a large picture's memory is released with its instance.
      const { exports } = await WebAssembly.instantiate(compiled);
      const result = decodeJPEG2000Module(
        exports as unknown as JPEG2000Module,
        new Uint8Array(data.buffer),
        data.settings,
      );
      port.send({ id: data.id, result }, [result.data.buffer as ArrayBuffer]);
    } catch (error) {
      port.send({
        id: data.id,
        error: error instanceof Error ? error.message : String(error),
        code: (error as { code?: string })?.code ?? (error instanceof RangeError ? 'range' : 'failed'),
      });
    }
  });
});
