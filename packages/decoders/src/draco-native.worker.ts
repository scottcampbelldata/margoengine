import { decodeNativeDraco, decodeNativePoints, loadNativeDraco } from './draco-native-codec.js';
import { dracoPointsTransferables, dracoTransferables, isDecoderCrash } from './codec.js';
import { decodeFailed } from './errors.js';
import type { DracoRequest } from './protocol.js';

declare const self: {
  onmessage:
    | ((
        event: MessageEvent<{ id: number; type: string; buffer: ArrayBuffer; wasmURL: string; request: DracoRequest }>,
      ) => void)
    | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};
let loading: ReturnType<typeof loadNativeDraco> | undefined;
self.onmessage = async ({ data }) => {
  try {
    loading ??= loadNativeDraco(data.wasmURL).catch((error) => {
      loading = undefined;
      throw error;
    });
    const module = await loading;
    if (data.type === 'points') {
      const result = decodeNativePoints(module, new Uint8Array(data.buffer), data.request);
      self.postMessage({ id: data.id, result }, dracoPointsTransferables(result));
    } else {
      const result = decodeNativeDraco(module, new Uint8Array(data.buffer), data.request);
      self.postMessage({ id: data.id, result }, dracoTransferables(result));
    }
  } catch (cause) {
    if (isDecoderCrash(cause)) loading = undefined;
    const error = (cause as { code?: string })?.code
      ? cause
      : decodeFailed(
          `Draco: ${cause instanceof Error ? cause.message : String(cause)}; check the input and decoder asset URL`,
          cause,
        );
    self.postMessage({ id: data.id, error: (error as Error).message, code: (error as { code?: string }).code });
  }
};
