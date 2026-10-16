// Worker script for @margoengine/usdz/worker (bundled to dist/workers/usdz.js): fetch, archive, USD parse, texture
// decoding and gltf-pro's prepare step (accessors, packed vertices) off the main thread.
import { GLTFAsset } from '@margoengine/gltf-pro/asset';
import { prepareAsset } from '@margoengine/gltf-pro/prepare';
import { fetchBytes } from '@margoengine/loaders';
import { serve } from '../../shared/worker.js';
import { parseUSDZ, type USDOptions } from './index.js';
import { parseUSD } from './any.js';
serve(async ({ url, input, options }: { url?: string; input?: ArrayBuffer | string; options: USDOptions }) => {
  const usd = url
    ? await parseUSDZ(await fetchBytes(url, { maxBytes: options.maxBytes ?? 64 * 1024 * 1024 }), options)
    : await parseUSD(input!, options);
  return prepareAsset(new GLTFAsset(usd.document, usd.buffers), await usd.images());
});
