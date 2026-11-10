/**
 * Image decoding where `createImageBitmap` is missing (Node), through `@margoengine/decoders/image`.
 * Its own module so the classic parser workers, which always have `createImageBitmap`, swap it for a stub
 * (scripts/build-workers.js) and never name the decoder package: an IIFE has no module URL to resolve it from.
 */
export async function decodeWithoutBrowser(data: Uint8Array, signal?: AbortSignal) {
  // Runtime resolution in Node: browser bundlers must not discover optional codec workers/Wasm while
  // merely reading a model-free install kit's exports, before tree shaking removes this loader.
  const decoderEntry = '@margoengine/decoders/image';
  const { decodeImage } = (await import(
    /* @vite-ignore */ /* webpackIgnore: true */ decoderEntry
  )) as typeof import('@margoengine/decoders/image');
  return decodeImage(data, { signal });
}
