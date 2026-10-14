// Worker script for @margoengine/fbx/worker (bundled to dist/workers/fbx.js): fetch, FBX -> GLB, then gltf-pro's
// prepare step (JSON, accessors, packed vertices, decoded textures), all off the main thread.
import {prepareGLTF} from '@margoengine/gltf-pro/prepare';
import {readResponse} from '../../shared/loading.js';
import {serve} from '../../shared/worker.js';
import {convertFBX} from './index.js';
const budget = 64 * 1024 * 1024; // convertFBX's input budget
serve(async ({url, input, resourcePath}: {url?: string; input?: ArrayBuffer; resourcePath?: string}) => {
  if (url) {
    const response = await fetch(url);
    input = (await readResponse(response, {maxBytes: budget, label: 'FBX'})).buffer;
    resourcePath ??= new URL('.', response.url || url).href;
  }
  const prepared = await prepareGLTF(undefined, await convertFBX(input!, {resourcePath}));
  // parseFBX's texture budget (all textures together), checked after decoding as it does.
  if (prepared.images.reduce((sum, image) => sum + (image ? image.width * image.height : 0), 0) > 16_000_000) {
    for (const image of prepared.images) if (image && 'close' in image) image.close();
    throw new RangeError('FBX texture pixel budget exceeded');
  }
  return prepared;
});
