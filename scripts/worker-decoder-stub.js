// Classic parser workers are one IIFE. The real @margoengine/decoders module locates its Wasm with
// import.meta.url, which that format replaces with {}. Draco and KTX2 stay on the thread that loads
// the package; a compressed file is handed back before this runs.
function unavailable(name) {
  return class {
    constructor() {
      throw new Error(`${name} decoding stays on the main thread`);
    }
  };
}

export const DracoDecoder = unavailable('Draco');
export const KTX2Decoder = unavailable('KTX2');

/** GPU upload helpers. The worker never reaches them; compressed images are handed back first. */
export function createKTX2Texture() {
  throw new Error('KTX2 decoding stays on the main thread');
}
export function getBytesPerRow() {
  throw new Error('KTX2 decoding stays on the main thread');
}
