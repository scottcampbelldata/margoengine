// Worker script for @margoengine/usdz/worker (bundled to dist/workers/usdz.js): fetch, archive, USD parse, texture
// decoding and gltf-pro's prepare step (accessors, packed vertices) off the main thread.
import { GLTFAsset } from '@margoengine/gltf-pro/asset';
import { prepareAsset } from '@margoengine/gltf-pro/prepare';
import { fetchBytes } from '@margoengine/loaders/common';
import { serve } from '../../shared/worker.js';
import { parseUSDZ, type USDExtension, type USDOptions } from './index.js';
import { parseUSD } from './any.js';
import { composition } from './compose.js';
import { skeletons } from './skel.js';
import { animation } from './anim.js';

const known: Record<string, (options?: never) => USDExtension> = { compose: composition, skel: skeletons, anim: animation };
serve(async ({ url, input, options: sent }: { url?: string; input?: ArrayBuffer | string; options: USDOptions }) => {
  const options: USDOptions = {
    ...sent,
    extensions: (sent.extensions as ({ name: string; options?: never } & USDExtension)[] | undefined)?.map(({ name, options }) => known[name](options)),
  };
  const usd = url
    ? await parseUSDZ(await fetchBytes(url, { maxBytes: options.maxBytes ?? 64 * 1024 * 1024 }), options)
    : await parseUSD(input!, options);
  return prepareAsset(new GLTFAsset(usd.document, usd.buffers), await usd.images());
});
