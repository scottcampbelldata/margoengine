// Classic parser workers run in browsers, which give every dedicated worker createImageBitmap, so gltf-pro's Node
// fallback (packages/gltf-pro/src/node-image-decode.ts) is never reached there. This stub keeps the worker free of
// the @margoengine/decoders specifier, which an IIFE could not resolve anyway.
export async function decodeWithoutBrowser() {
  throw new TypeError(
    'createImageBitmap is not available in this worker; load the model on the page or in Node to decode its images',
  );
}
